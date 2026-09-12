import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createE2EHarness } from "./harness.mjs";

/**
 * The self-write sync-loop guard.
 *
 * main.ts writes frontmatter after a successful sync. In a real vault that write fires a
 * "modify" event, which — if treated as a user edit — bumps the destination revision and,
 * with autoSync on, schedules ANOTHER sync, whose write fires another "modify", and so on.
 * processFrontMatterGuarded + the guard in the vault.on("modify") handler exist to break
 * that cycle.
 *
 * Until now this was structurally untestable: vault.on() was a no-op, registerEvent()
 * unloaded refs immediately, DiskTFile failed the `instanceof TFile` gate, and the
 * window.setTimeout stub cleared the 2500ms guard synchronously before it could apply.
 */

let active;

afterEach(async () => {
  if (active) {
    await active.destroy();
    active = null;
  }
});

test("e2e: plugin registers a real vault modify listener", async () => {
  active = await createE2EHarness();
  assert.ok(
    active.app.vault._listenerCount("modify") >= 1,
    "plugin must retain a vault modify listener after onload",
  );
});

test("e2e: vault hands out real TFile instances so instanceof gates are reachable", async () => {
  active = await createE2EHarness();
  const { TFile } = (await import("node:module"))
    .createRequire(new URL("./disk-vault.mjs", import.meta.url))("./obsidian-harness.cjs");
  assert.ok(active.file instanceof TFile, "note must satisfy `file instanceof TFile`");
});

test("e2e: the plugin's own frontmatter write does not trigger a re-sync", async () => {
  active = await createE2EHarness({ settings: { autoSync: true, syncMode: "all" } });
  active.worker.setCaptureId?.("loop-entry-1");

  assert.equal(await active.plugin.syncFile(active.file, true), true);
  const afterFirst = active.captureRequests().length;
  assert.equal(afterFirst, 1, "first sync should capture exactly once");

  // Let the "modify" event emitted by the plugin's own frontmatter write be delivered.
  await active.app.vault._settle();
  await new Promise((r) => setTimeout(r, 50));
  await active.app.vault._settle();

  assert.equal(
    active.captureRequests().length,
    afterFirst,
    "the plugin's own frontmatter write must NOT cause another capture (sync loop)",
  );
});

test("e2e: a genuine external edit is still observed after a self-write is swallowed", async () => {
  active = await createE2EHarness({ settings: { autoSync: false } });
  active.worker.setCaptureId?.("loop-entry-2");

  assert.equal(await active.plugin.syncFile(active.file, true), true);
  await active.app.vault._settle();

  const revisionAfterSelfWrite = active.plugin.destinationRevisions.get(active.file.path) ?? 0;

  // Now simulate a real user edit: a "modify" the plugin did not cause.
  active.app.vault._emit("modify", active.file);
  await active.app.vault._settle();

  const revisionAfterUserEdit = active.plugin.destinationRevisions.get(active.file.path) ?? 0;
  assert.ok(
    revisionAfterUserEdit > revisionAfterSelfWrite,
    `external edit must bump the destination revision (was ${revisionAfterSelfWrite}, now ${revisionAfterUserEdit})`,
  );
});
