import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, beforeEach, after } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundleDir = mkdtempSync(join(tmpdir(), "second-brain-plugin-tests-"));
const bundlePath = join(bundleDir, "main.cjs");

buildSync({
  entryPoints: [join(root, "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  alias: { obsidian: join(root, "tests", "obsidian-stub.ts") },
  outfile: bundlePath,
});

const require = createRequire(import.meta.url);
const { default: SecondBrainPlugin } = require(bundlePath);

globalThis.window = {
  setTimeout(callback) {
    callback();
    return 1;
  },
  clearTimeout() {},
};
globalThis.document = {
  createElement() {
    return {
      addEventListener() {},
      remove() {},
      setAttribute() {},
      classList: { add() {}, remove() {} },
    };
  },
};

const DEFAULT_SETTINGS = {
  workerUrl: "https://worker.example",
  authToken: "test-token",
  syncMode: "all",
  syncTag: "brain",
  autoSync: false,
  autoSyncDelay: 5000,
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: false,
  lastSyncTime: null,
  importFolder: "_Second Brain/Inbox",
  importTag: "obsidian-inbox",
  importLimit: 20,
  pullOnStartup: false,
  importedIds: [],
  defaultDestination: { workspace: "personal" },
};

function makeFile(path, content, frontmatter = {}, inlineTags = []) {
  return {
    path,
    name: path.split("/").at(-1),
    basename: path.split("/").at(-1).replace(/\.md$/, ""),
    extension: "md",
    parent: { name: path.includes("/") ? path.split("/").at(-2) : "" },
    content,
    frontmatter,
    inlineTags,
  };
}

function makeApp(file) {
  let frontmatterCalls = 0;
  const events = new Map();
  return {
    vault: {
      async read(target) { return target.content; },
      getMarkdownFiles() { return [file]; },
      getAbstractFileByPath() { return null; },
      on(name, callback) {
        events.set(name, callback);
        return { unload() { events.delete(name); } };
      },
      async createFolder() {},
      async create() {},
    },
    metadataCache: {
      getFileCache(target) {
        return { frontmatter: target.frontmatter, tags: target.inlineTags.map((tag) => ({ tag })) };
      },
    },
    fileManager: {
      async processFrontMatter(target, callback) {
        frontmatterCalls += 1;
        callback(target.frontmatter);
      },
    },
    workspace: {
      getActiveFile() { return file; },
      onLayoutReady(callback) { callback(); },
      on(name, callback) {
        events.set(`workspace:${name}`, callback);
        return { unload() { events.delete(`workspace:${name}`); } };
      },
      getLeavesOfType() { return []; },
      getRightLeaf() { return null; },
    },
    get frontmatterCalls() { return frontmatterCalls; },
    events,
  };
}

function makePlugin({ file, settings = {}, responses = [] } = {}) {
  const target = file ?? makeFile("Notes/Example.md", "Example\n\nA note.");
  const app = makeApp(target);
  const requests = [];
  let saveCount = 0;
  let responseIndex = 0;

  globalThis.__obsidianTestNotices = [];
  globalThis.__obsidianTestRequestUrl = async (options) => {
    requests.push({ ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = typeof responses === "function" ? await responses(options, requests) : responses[responseIndex++];
    if (next instanceof Error) throw next;
    return next ?? { status: 200, json: { ok: true, id: `entry-${requests.length}` } };
  };

  const plugin = new SecondBrainPlugin(app, {});
  plugin.settings = { ...DEFAULT_SETTINGS, ...settings };
  plugin.saveSettings = async () => { saveCount += 1; };
  plugin.updateStatusBar = () => {};
  return { plugin, app, file: target, requests, notices: globalThis.__obsidianTestNotices, get saveCount() { return saveCount; } };
}

function jsonResponse(json, status = 200) {
  return { status, json };
}

function destination(body) {
  return {
    workspace: body.workspace ?? body["second-brain-workspace"],
    team: body.team ?? body["second-brain-team"],
  };
}

beforeEach(() => {
  globalThis.__obsidianTestNotices = [];
});

after(() => {
  delete globalThis.__obsidianTestRequestUrl;
  delete globalThis.__obsidianTestNotices;
  rmSync(bundleDir, { recursive: true, force: true });
});

test("first sync captures once and pins the returned ID", async () => {
  const h = makePlugin({ responses: [jsonResponse({ ok: true, id: "stable-1" })] });

  assert.equal(await h.plugin.syncFile(h.file), true);
  assert.deepEqual(h.requests.map((request) => request.url), ["https://worker.example/capture"]);
  assert.equal(h.requests[0].body.source, "obsidian");
  assert.deepEqual(h.file.frontmatter["second-brain-id"], "stable-1");
  assert.ok(h.app.frontmatterCalls >= 3, "destination, progress, and completion should be persisted");
});

test("existing IDs are updated in place and do not append duplicate content", async () => {
  const file = makeFile("Example.md", "Example\n\nChanged content", {
    "second-brain-id": "stable-1",
    "second-brain-workspace": "personal",
  });
  const h = makePlugin({ file, responses: [jsonResponse({ ok: true }), jsonResponse({ ok: true })] });

  assert.equal(await h.plugin.syncFile(file), true);
  assert.deepEqual(h.requests.map((request) => request.url), ["https://worker.example/share", "https://worker.example/update"]);
  assert.equal(h.requests[1].body.id, "stable-1");
  assert.match(h.requests[1].body.content, /Changed content/);
  assert.equal(h.file.frontmatter["second-brain-id"], "stable-1");
});

test("HTTP 200 with ok:false is a failed sync and never adopts a missing/false ID", async () => {
  const file = makeFile("Example.md", "Example\n\nNew content");
  const h = makePlugin({ file, responses: [jsonResponse({ ok: false, error: "duplicate" })] });

  assert.equal(await h.plugin.syncFile(file), false);
  assert.equal(h.file.frontmatter["second-brain-id"], undefined);
  assert.equal(h.saveCount, 0);
  assert.equal(h.notices.some((notice) => /error|duplicate/i.test(notice)), true);
});

test("chunk growth captures only new chunks while preserving stable IDs", async () => {
  const file = makeFile("Example.md", "Example\n\n1234567890", {
    "second-brain-id": ["chunk-1"],
    "second-brain-workspace": "personal",
  });
  const h = makePlugin({ file, settings: { chunkSize: 15, chunkOverlap: 0 }, responses: [
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true, id: "chunk-2" }),
  ] });

  assert.equal(await h.plugin.syncFile(file), true);
  assert.deepEqual(h.requests.map((request) => request.url), [
    "https://worker.example/share",
    "https://worker.example/update",
    "https://worker.example/capture",
    "https://worker.example/capture",
  ]);
  assert.equal(h.file.frontmatter["second-brain-id"][0], "chunk-1");
  assert.equal(h.file.frontmatter["second-brain-id"].length, 3);
});

test("partial chunk failure persists progress only on a later successful retry", async () => {
  const file = makeFile("Example.md", "Example\n\n12345678901234567890", {
    "second-brain-id": ["chunk-1"],
    "second-brain-workspace": "personal",
  });
  const h = makePlugin({ file, settings: { chunkSize: 20, chunkOverlap: 0 }, responses: [
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true }),
    jsonResponse({ ok: false, error: "temporary" }, 503),
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true, id: "chunk-2" }),
  ] });

  assert.equal(await h.plugin.syncFile(file, true), false);
  assert.equal(h.file.frontmatter["second-brain-id"], "chunk-1");
  assert.equal(await h.plugin.syncFile(file, true), true);
  assert.deepEqual(h.file.frontmatter["second-brain-id"], ["chunk-1", "chunk-2"]);
});

test("shrinking a note untracks surplus IDs without deleting remote memories", async () => {
  const file = makeFile("Example.md", "Example\n\nshort", {
    "second-brain-id": ["chunk-1", "chunk-2"],
    "second-brain-workspace": "personal",
  });
  const h = makePlugin({ file, settings: { chunkSize: 1600 }, responses: [jsonResponse({ ok: true }), jsonResponse({ ok: true })] });

  assert.equal(await h.plugin.syncFile(file), true);
  assert.deepEqual(h.requests.map((request) => request.url), ["https://worker.example/share", "https://worker.example/share", "https://worker.example/update"]);
  assert.deepEqual(h.file.frontmatter["second-brain-id"], "chunk-1");
  assert.equal(h.file.frontmatter["second-brain-retired-ids"], "chunk-2");
  assert.equal(h.requests.some((request) => request.url.endsWith("/forget")), false);
});

test("tag eligibility includes normalized inline and scalar frontmatter tags", async () => {
  const file = makeFile("Example.md", "Example\n\n#brain", { tags: "brain" }, ["#brain"]);
  const h = makePlugin({ file, settings: { syncMode: "tagged" }, responses: [jsonResponse({ ok: true, id: "tagged-1" })] });

  assert.equal(await h.plugin.syncIfTagged(file), undefined);
  assert.equal(h.requests.length, 1);
  assert.equal(h.file.frontmatter["second-brain-id"], "tagged-1");
});

test("malformed settings fail closed without making a request", async () => {
  const h = makePlugin({ settings: { workerUrl: "   ", authToken: "" } });

  assert.equal(await h.plugin.syncFile(h.file, true), false);
  assert.equal(h.requests.length, 0);
});

test("changing the default affects only newly synced notes", async () => {
  const file = makeFile("Example.md", "Example\n\nDefault note");
  const h = makePlugin({ file, responses: [
    jsonResponse({ ok: true, id: "personal-1" }),
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true }),
  ] });

  assert.equal(await h.plugin.syncFile(file, true), true);
  assert.equal(file.frontmatter["second-brain-workspace"], "personal");
  h.plugin.settings.defaultDestination = { workspace: "company", teamId: "team-b" };
  file.content = "Example\n\nChanged after default switch";
  assert.equal(await h.plugin.syncFile(file, true), true);
  const secondSync = h.requests.slice(1);
  assert.deepEqual(secondSync.map((request) => request.url), ["https://worker.example/share", "https://worker.example/update"]);
  assert.deepEqual(destination(secondSync[0].body), { workspace: "personal", team: undefined });
  assert.equal(file.frontmatter["second-brain-team"], undefined);
});

test("a company default without a named team fails closed before capture", async () => {
  const h = makePlugin({ settings: { defaultDestination: { workspace: "company" } } });

  assert.equal(await h.plugin.syncFile(h.file, true), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.file.frontmatter["second-brain-id"], undefined);
});

test("named team capture sends the stable team ID, not the display name", async () => {
  const file = makeFile("Example.md", "Example\n\nCompany note", {
    "second-brain-workspace": "company",
    "second-brain-team": "team-a",
  });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.endsWith("/team/workspaces")) {
      return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha Team" }, { id: "team-b", name: "Beta Team" }] });
    }
    return jsonResponse({ ok: true, id: "company-1" });
  } });

  assert.equal(await h.plugin.syncFile(file, true), true);
  const capture = h.requests.find((request) => request.url.endsWith("/capture"));
  assert.deepEqual(destination(capture.body), { workspace: "company", team: "team-a" });
  assert.notEqual(capture.body.team, "Alpha Team");
  assert.equal(file.frontmatter["second-brain-team"], "team-a");
});

test("legacy IDs in multiple company teams remain unmoved until the user chooses", async () => {
  const file = makeFile("Example.md", "Example\n\nLegacy note", { "second-brain-id": ["legacy-a", "legacy-b"] });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.includes("/entry?id=legacy-a")) return jsonResponse({ ok: true, entry: { id: "legacy-a", workspace: "company", can_edit: true } });
    if (options.url.includes("/entry?id=legacy-b")) return jsonResponse({ ok: true, entry: { id: "legacy-b", workspace: "company", can_edit: true } });
    if (options.url.endsWith("/team/workspaces")) return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha" }, { id: "team-b", name: "Beta" }] });
    throw new Error(`unexpected request ${options.url}`);
  } });

  assert.equal(await h.plugin.syncFile(file, true), false);
  assert.equal(h.requests.some((request) => /\/share$|\/update$|\/capture$/.test(request.url)), false);
  assert.deepEqual(file.frontmatter["second-brain-id"], ["legacy-a", "legacy-b"]);
});

test("a revoked team membership fails closed without adopting the note", async () => {
  const file = makeFile("Example.md", "Example\n\nCompany note", {
    "second-brain-workspace": "company",
    "second-brain-team": "revoked-team",
  });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.endsWith("/team/workspaces")) return jsonResponse({ ok: true, teams: [{ id: "current-team", name: "Current" }] });
    throw new Error(`unexpected request ${options.url}`);
  } });

  assert.equal(await h.plugin.syncFile(file, true), false);
  assert.equal(h.requests.some((request) => request.url.endsWith("/capture")), false);
  assert.equal(file.frontmatter["second-brain-id"], undefined);
});

test("a name-only note adopts the resolved team ID and writes the name back", async () => {
  const file = makeFile("Example.md", "Example\n\nName-only note", {
    "second-brain-workspace": "company",
    "second-brain-team-name": "Alpha Team",
  });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.endsWith("/team/workspaces")) {
      return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha Team" }] });
    }
    return jsonResponse({ ok: true, id: "company-1" });
  } });

  assert.equal(await h.plugin.syncFile(file, true), true);
  const capture = h.requests.find((request) => request.url.endsWith("/capture"));
  assert.deepEqual(destination(capture.body), { workspace: "company", team: "team-a" });
  assert.equal(file.frontmatter["second-brain-team"], "team-a");
  assert.equal(file.frontmatter["second-brain-team-name"], "Alpha Team");
});

test("a hand-edited name reroutes to the new team: /share runs before /update, ID and name both update", async () => {
  const file = makeFile("Example.md", "Example\n\nRerouted note", {
    "second-brain-id": "stable-1",
    "second-brain-workspace": "company",
    "second-brain-team": "team-a",
    "second-brain-team-name": "Beta Team", // hand-edited; team-a is still "Alpha Team"
  });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.endsWith("/team/workspaces")) {
      return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha Team" }, { id: "team-b", name: "Beta Team" }] });
    }
    return jsonResponse({ ok: true });
  } });

  assert.equal(await h.plugin.syncFile(file, true), true);
  const shareIdx = h.requests.findIndex((request) => request.url.endsWith("/share"));
  const updateIdx = h.requests.findIndex((request) => request.url.endsWith("/update"));
  assert.ok(shareIdx >= 0 && updateIdx >= 0 && shareIdx < updateIdx, "/share must precede /update");
  assert.equal(h.requests[shareIdx].body.team, "team-b");
  assert.equal(file.frontmatter["second-brain-team"], "team-b");
  assert.equal(file.frontmatter["second-brain-team-name"], "Beta Team");
});

test("an ambiguous team name fails closed before any capture request and notifies about the collision", async () => {
  const file = makeFile("Example.md", "Example\n\nAmbiguous note", {
    "second-brain-workspace": "company",
    "second-brain-team-name": "Shared Name",
  });
  const h = makePlugin({ file, responses: (options) => {
    if (options.url.endsWith("/team/workspaces")) {
      return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Shared Name" }, { id: "team-b", name: "Shared Name" }] });
    }
    throw new Error(`unexpected request ${options.url}`);
  } });

  assert.equal(await h.plugin.syncFile(file, true), false);
  assert.equal(h.requests.some((request) => request.url.endsWith("/capture")), false);
  assert.ok(h.notices.some((notice) => /collision|ambiguous|multiple/i.test(notice)));
});

for (const [label, properties] of [
  ["personal", { "second-brain-workspace": "personal" }],
  ["team alpha", { "second-brain-workspace": "company", "second-brain-team": "team-a" }],
  ["team beta", { "second-brain-workspace": "company", "second-brain-team": "team-b" }],
]) {
  test(`tracked memories move to the selected ${label} destination by ID`, async () => {
    const file = makeFile("Example.md", "Example\n\nMoved note", { "second-brain-id": "stable-1", ...properties });
    const h = makePlugin({ file, responses: (options) => {
      if (options.url.endsWith("/team/workspaces")) return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha" }, { id: "team-b", name: "Beta" }] });
      return jsonResponse({ ok: true });
    } });

    assert.equal(await h.plugin.syncFile(file, true), true);
    const share = h.requests.find((request) => request.url.endsWith("/share"));
    assert.deepEqual(destination(share.body), {
      workspace: properties["second-brain-workspace"],
      team: properties["second-brain-team"],
    });
    assert.equal(share.body.id, "stable-1");
  });
}

test("team discovery becomes stale when the connection changes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makePlugin({ responses: async (options) => {
    assert.match(options.url, /\/team\/workspaces$/);
    await gate;
    return jsonResponse({ ok: true, teams: [{ id: "team-a", name: "Alpha" }] });
  } });

  const loading = h.plugin.loadTeams();
  await new Promise((resolve) => setImmediate(resolve));
  h.plugin.settings.workerUrl = "https://changed.example";
  h.plugin.settings.authToken = "changed-token";
  release();
  await assert.rejects(loading, /stale|connection changed/i);
});

test("a sync request uses the connection and destination captured at dispatch", async () => {
  const file = makeFile("Example.md", "Example\n\nContent", {
    "second-brain-id": "stable-1",
    "second-brain-workspace": "personal",
  });
  let resolveRequest;
  const requestGate = new Promise((resolve) => { resolveRequest = resolve; });
  const h = makePlugin({ file, settings: { workerUrl: "https://old.example", authToken: "old-token" }, responses: async (options) => {
    await requestGate;
    return jsonResponse({ ok: true });
  } });

  const sync = h.plugin.syncFile(file, true);
  await new Promise((resolve) => setImmediate(resolve));
  h.plugin.settings.workerUrl = "https://new.example";
  h.plugin.settings.authToken = "new-token";
  resolveRequest();
  assert.equal(await sync, false);
  assert.equal(h.requests[0].url, "https://old.example/share");
  assert.equal(h.requests[0].headers.Authorization, "Bearer old-token");
  assert.deepEqual(file.frontmatter["second-brain-id"], "stable-1");
});

test("unload cleanup is idempotent for registered resources", async () => {
  const h = makePlugin();
  const registered = [];
  h.plugin.registerEvent = (event) => registered.push(event);
  h.plugin.register = (cleanup) => registered.push({ unload: cleanup });
  await h.plugin.onload();
  assert.ok(registered.length >= 2);
  for (const item of registered) item.unload?.();
  for (const item of registered) item.unload?.();
});
