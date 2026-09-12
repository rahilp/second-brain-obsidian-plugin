import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createE2EHarness, driveDestinationPicker } from "./harness.mjs";

/** @type {import("./harness.mjs").createE2EHarness extends (...args: any) => Promise<infer H> ? H : never} */
let active;

afterEach(async () => {
  if (active) {
    await active.destroy();
    active = null;
  }
});

test("e2e: loads npm-built main.js bundle (not main.ts source)", async () => {
  active = await createE2EHarness({ onload: false });
  assert.equal(typeof active.plugin.syncFile, "function");
  assert.match(active.plugin.constructor.toString(), /Plugin|class/);
});

test("e2e: fresh personal note sync hits real HTTP capture and writes valid YAML", async () => {
  active = await createE2EHarness();
  workerSetCaptureId(active, "personal-entry-1");

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  assert.equal(active.worker.requests.length >= 1, true);
  const capture = active.captureRequests()[0];
  assert.ok(capture, "must POST /capture over HTTP");
  assert.equal(capture.body.workspace, "personal");
  assert.equal(capture.body.team, undefined);
  assert.equal(capture.body.source, "obsidian");

  const { frontmatter } = await active.assertFileIntegrity();
  assert.equal(frontmatter["second-brain-id"], "personal-entry-1");
  assert.equal(frontmatter["second-brain-workspace"], "personal");
});

test("e2e: company sync sends stable team ID on wire, not display name", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team": "team-a",
    },
  });
  active.worker.setTeams([{ id: "team-a", name: "Alpha Team" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  const capture = active.captureRequests()[0];
  assert.ok(capture);
  assert.equal(capture.body.workspace, "company");
  assert.equal(capture.body.team, "team-a");
  assert.notEqual(capture.body.team, "Alpha Team");

  const { frontmatter } = await active.assertFileIntegrity();
  assert.equal(frontmatter["second-brain-team"], "team-a");
});

test("e2e: destination picker drives real Modal and persists team to disk YAML", async () => {
  active = await createE2EHarness();
  active.worker.setTeams([
    { id: "team-a", name: "Alpha Team" },
    { id: "team-b", name: "Beta Team" },
  ]);

  await driveDestinationPicker(active, "team-b");

  const fm = await active.frontmatterOnDisk();
  assert.equal(fm["second-brain-workspace"], "company");
  assert.equal(fm["second-brain-team"], "team-b");
  await active.assertFileIntegrity();
});

test("e2e: picker destination change then sync calls /share before /update", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-id": "stable-1",
      "second-brain-workspace": "personal",
    },
  });
  active.worker.setTeams([
    { id: "team-a", name: "Alpha Team" },
    { id: "team-b", name: "Beta Team" },
  ]);

  await driveDestinationPicker(active, "team-a");
  active.worker.resetRequests();

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  const order = active.worker.requests.map((r) => r.path.split("?")[0]);
  const shareIdx = order.indexOf("/share");
  const updateIdx = order.indexOf("/update");
  assert.ok(shareIdx >= 0, "share must be called");
  assert.ok(updateIdx >= 0, "update must be called");
  assert.ok(shareIdx < updateIdx, `/share (${shareIdx}) must precede /update (${updateIdx})`);

  const share = active.shareRequests()[0];
  assert.equal(share.body.workspace, "company");
  assert.equal(share.body.team, "team-a");
});

test("e2e: company default without valid team never reaches network", async () => {
  active = await createE2EHarness({
    settings: { defaultDestination: { workspace: "company" } },
  });
  active.worker.setTeams([{ id: "team-a", name: "Alpha" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  assert.equal(active.captureRequests().length, 0);
  assert.equal(active.shareRequests().length, 0);
  assert.equal(active.updateRequests().length, 0);
  await active.assertFileIntegrity();
});

test("e2e: revoked team membership fails closed with zero capture requests", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team": "revoked-team",
    },
  });
  active.worker.setTeams([{ id: "current-team", name: "Current" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  assert.equal(active.captureRequests().length, 0);
  await active.assertFileIntegrity();
});

test("e2e: Authorization bearer token is sent on real HTTP requests", async () => {
  active = await createE2EHarness({ authToken: "secret-bearer-xyz" });

  await active.plugin.syncFile(active.file, true);

  assert.ok(active.worker.requests.length > 0);
  for (const req of active.worker.requests) {
    const auth = req.headers.authorization ?? req.headers.Authorization;
    assert.equal(auth, "Bearer secret-bearer-xyz", `${req.method} ${req.path} must carry auth`);
  }
});

test("e2e: HTTP 500 on capture fails sync without corrupting on-disk YAML", async () => {
  active = await createE2EHarness();
  active.worker.setRoute("POST /capture", { status: 500, json: { ok: false, error: "boom" } });

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  const { frontmatter } = await active.assertFileIntegrity();
  assert.equal(frontmatter["second-brain-id"], undefined);
});

test("e2e: HTTP 200 ok:false on capture fails closed and preserves YAML integrity", async () => {
  active = await createE2EHarness();
  active.worker.setRoute("POST /capture", { status: 200, json: { ok: false, error: "duplicate" } });

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  await active.assertFileIntegrity();
});

test("e2e: malformed JSON response fails capture safely", async () => {
  active = await createE2EHarness();
  active.worker.setRoute("POST /capture", { status: 200, rawBody: "{not-json" });

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  await active.assertFileIntegrity();
});

test("e2e: slow worker response still completes sync", async () => {
  active = await createE2EHarness();
  active.worker.setRoute("POST /capture", { delayMs: 50, json: { ok: true, id: "slow-1" } });

  assert.equal(await active.plugin.syncFile(active.file, true), true);
  assert.equal(active.captureRequests().length, 1);
  await active.assertFileIntegrity();
});

test("e2e: team list can change between calls without crashing the harness", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team": "team-a",
    },
  });
  active.worker.setTeamsProvider((callIndex) =>
    callIndex === 0
      ? [{ id: "team-a", name: "Alpha v1" }]
      : [{ id: "team-a", name: "Alpha v2" }],
  );

  assert.equal(await active.plugin.syncFile(active.file, true), true);
  await active.assertFileIntegrity();
});

function workerSetCaptureId(h, id) {
  h.worker.setRoute("POST /capture", {
    handler: () => ({ status: 200, json: { ok: true, id } }),
  });
}
