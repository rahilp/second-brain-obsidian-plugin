import assert from "node:assert/strict";
import { loadBuiltPlugin, DEFAULT_SETTINGS, installBrowserGlobals } from "./load-plugin.mjs";
import { createDiskVault } from "./disk-vault.mjs";
import { createWorkerServer } from "./worker-server.mjs";
import { assertValidYamlFrontmatter, parseMarkdownFile } from "./yaml-frontmatter.mjs";

export { assert, DEFAULT_SETTINGS };

export async function createE2EHarness(options = {}) {
  installBrowserGlobals();
  const Plugin = loadBuiltPlugin();
  const worker = await createWorkerServer(options.worker ?? {});
  const vault = await createDiskVault();

  const body = options.body ?? "Example\n\nBody text stays intact.";
  const frontmatter = options.frontmatter ?? {};
  const notePath = options.notePath ?? "Notes/Example.md";
  const file = await vault.writeNote(notePath, body, frontmatter);
  const originalDiskRaw = await vault.readNoteRaw(notePath);
  const originalBody = parseMarkdownFile(originalDiskRaw).body;

  const app = vault.makeApp(file);
  app.vault.registerFile(file);
  await app.metadataCache.reloadFromDisk(file);

  const plugin = new Plugin(app, { id: "second-brain-e2e", name: "E2E" });
  plugin.saveSettings = async () => {};
  plugin.updateStatusBar = () => {};

  if (options.onload !== false) {
    await plugin.onload();
  }

  // onload() calls loadSettings() and would wipe injected worker URL/token.
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    ...plugin.settings,
    workerUrl: worker.baseUrl,
    authToken: options.authToken ?? "e2e-test-token",
    ...options.settings,
  };

  return {
    plugin,
    app,
    file,
    vault,
    worker,
    originalBody,
    notices: () => globalThis.__obsidianTestNotices ?? [],

    async readDisk() {
      return vault.readNoteRaw(file.path);
    },

    async frontmatterOnDisk() {
      const raw = await vault.readNoteRaw(file.path);
      return parseMarkdownFile(raw).frontmatter;
    },

    assertYamlIntegrity(label) {
      return assertValidYamlFrontmatter;
    },

    async assertFileIntegrity(label = file.path) {
      const raw = await vault.readNoteRaw(file.path);
      const { frontmatter, body: diskBody } = assertValidYamlFrontmatter(raw, label);
      assert.equal(diskBody, originalBody,
        `${label}: markdown body must stay byte-identical apart from frontmatter block`);
      return { frontmatter, raw, body: diskBody };
    },

    captureRequests() {
      return worker.requests.filter((r) => r.path.startsWith("/capture"));
    },

    shareRequests() {
      return worker.requests.filter((r) => r.path.startsWith("/share"));
    },

    updateRequests() {
      return worker.requests.filter((r) => r.path.startsWith("/update"));
    },

    async destroy() {
      await worker.close();
      await vault.destroy();
      globalThis.__obsidianTestNotices = [];
    },
  };
}

/** Open destination picker, wait for teams, select value, save. */
export async function driveDestinationPicker(h, teamValue) {
  const cmd = h.plugin.commands.get("set-memory-destination");
  assert.ok(cmd, "set-memory-destination command must be registered");
  h.app.workspace.setActiveFile(h.file);
  cmd.callback();

  await waitFor(() => {
    const modal = h.app.workspace._lastModal;
    return modal && modal.loading === false && Array.isArray(modal.teams) && modal.teams.length > 0;
  }, 5000);

  const modalRoot = findModalRoot(h);
  assert.ok(modalRoot, "destination modal must render");
  const select = findSelect(modalRoot);
  assert.ok(select, "destination dropdown must exist");
  select.value = teamValue;
  for (const { type, handler } of select._listeners ?? []) {
    if (type === "change") handler();
  }

  const save = findSaveButton(modalRoot);
  assert.ok(save, "Save button must exist");
  save.click();

  await waitFor(async () => {
    const fm = await h.frontmatterOnDisk();
    return fm["second-brain-workspace"] === (teamValue === "personal" ? "personal" : "company");
  }, 3000);
  await h.app.metadataCache.reloadFromDisk(h.file);
}

function findModalRoot(h) {
  return h.plugin.app.workspace._lastModal?.contentEl ?? null;
}

function findSelect(root) {
  return walk(root, (el) => el.tagName === "SELECT");
}

function findSaveButton(root) {
  return walk(root, (el) => el.tagName === "BUTTON" && el.className.includes("mod-cta"));
}

function walk(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = walk(child, pred);
    if (hit) return hit;
  }
  return null;
}

function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch {
        // keep polling
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setImmediate(tick);
    };
    tick();
  });
}
