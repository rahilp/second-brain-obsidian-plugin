import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createE2EHarness } from "./harness.mjs";
import { assertValidYamlFrontmatter } from "./yaml-frontmatter.mjs";

/** @type {Awaited<ReturnType<import("./harness.mjs").createE2EHarness>> | null} */
let active;

afterEach(async () => {
  if (active) {
    await active.destroy();
    active = null;
  }
});

const HOSTILE_TEAM_NAMES = [
  ["spaces", "Acme Engineering"],
  ["colon", "Acme: Platform"],
  ["apostrophe", "Rahil's Team"],
  ["hash", "Team #1"],
  ["at", "team@corp"],
  ["emoji", "Rocket 🚀"],
  ["leading-trailing-ws", "  Padded Team  "],
  ["double-quotes", 'Team "Alpha"'],
  ["non-ascii", "Équipe Réseau"],
  ["yaml-bare-ops", "Ops"],
  ["yaml-bare-no", "No"],
  ["yaml-bare-yes", "Yes"],
  ["yaml-bare-null", "null"],
  ["yaml-bare-tilde", "~"],
  ["yaml-bare-true", "true"],
  ["yaml-bare-float", "1.0"],
];

for (const [label, teamName] of HOSTILE_TEAM_NAMES) {
  test(`[FEATURE-PENDING] hostile team name (${label}) round-trips through disk YAML without corruption`, async () => {
    // ID-only legacy note: plugin must backfill second-brain-team-name from /team/workspaces.
    // Pre-seeding the name would let this pass vacuously before the feature lands.
    active = await createE2EHarness({
      frontmatter: {
        "second-brain-workspace": "company",
        "second-brain-team": "team-a",
      },
    });
    active.worker.setTeams([{ id: "team-a", name: teamName }]);

    assert.equal(await active.plugin.syncFile(active.file, true), true);

    const raw = await active.readDisk();
    assertValidYamlFrontmatter(raw, `hostile-${label}`);

    const fm = await active.frontmatterOnDisk();
    assert.equal(fm["second-brain-team"], "team-a", "ID must stay authoritative");
    assert.equal(fm["second-brain-team-name"], teamName,
      "plugin must write hostile display name as valid YAML (quoted if needed)");
    await active.assertFileIntegrity(`hostile-${label}`);
  });
}

test("[FEATURE-PENDING] name-only frontmatter resolves to team ID and writes name back", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team-name": "Alpha Team",
    },
  });
  active.worker.setTeams([{ id: "team-a", name: "Alpha Team" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), true);
  assert.equal(active.captureRequests().length, 1);
  assert.equal(active.captureRequests()[0].body.team, "team-a");

  const fm = await active.frontmatterOnDisk();
  assert.equal(fm["second-brain-team"], "team-a");
  assert.equal(fm["second-brain-team-name"], "Alpha Team");
  await active.assertFileIntegrity();
});

test("[FEATURE-PENDING] legacy ID-only note backfills second-brain-team-name from team list", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team": "team-a",
    },
  });
  active.worker.setTeams([{ id: "team-a", name: "Alpha Team" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  const fm = await active.frontmatterOnDisk();
  assert.equal(fm["second-brain-team-name"], "Alpha Team");
  await active.assertFileIntegrity();
});

test("[FEATURE-PENDING] ambiguous team name fails closed with zero capture requests", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team-name": "Shared Name",
    },
  });
  active.worker.setTeams([
    { id: "team-a", name: "Shared Name" },
    { id: "team-b", name: "Shared Name" },
  ]);

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  assert.equal(active.captureRequests().length, 0);
  assert.equal(active.shareRequests().length, 0);
  assert.ok(
    active.notices().some((n) => /collision|ambiguous|multiple/i.test(n)),
    "must surface a notice about ambiguous team name",
  );
  await active.assertFileIntegrity();
});

test("[FEATURE-PENDING] hand-edited name reroute triggers /share before capture/update", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-id": "stable-1",
      "second-brain-workspace": "company",
      "second-brain-team": "team-a",
      "second-brain-team-name": "Alpha Team",
    },
  });
  active.worker.setTeams([
    { id: "team-a", name: "Alpha Team" },
    { id: "team-b", name: "Beta Team" },
  ]);

  // User re-routes by editing the display name only.
  const raw = await active.readDisk();
  const updated = raw.replace("Alpha Team", "Beta Team");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(active.file.absPath, updated, "utf8");
  await active.app.metadataCache.reloadFromDisk(active.file);
  active.worker.resetRequests();

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  const order = active.worker.requests.map((r) => r.path.split("?")[0]);
  const shareIdx = order.indexOf("/share");
  const updateIdx = order.indexOf("/update");
  assert.ok(shareIdx >= 0);
  assert.ok(updateIdx >= 0);
  assert.ok(shareIdx < updateIdx);

  const fm = await active.frontmatterOnDisk();
  assert.equal(fm["second-brain-team"], "team-b");
  assert.equal(fm["second-brain-team-name"], "Beta Team");
});

test("[FEATURE-PENDING] server-side rename refreshes stored name while ID stays authoritative", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team": "team-a",
      "second-brain-team-name": "Old Alpha Name",
    },
  });
  active.worker.setTeamsProvider((callIndex) =>
    callIndex === 0
      ? [{ id: "team-a", name: "Old Alpha Name" }]
      : [{ id: "team-a", name: "Renamed Alpha" }],
  );

  assert.equal(await active.plugin.syncFile(active.file, true), true);

  const fm = await active.frontmatterOnDisk();
  assert.equal(fm["second-brain-team"], "team-a");
  assert.equal(fm["second-brain-team-name"], "Renamed Alpha");
  await active.assertFileIntegrity();
});

test("[FEATURE-PENDING] invalid name with missing/invalid ID fails closed before capture", async () => {
  active = await createE2EHarness({
    frontmatter: {
      "second-brain-workspace": "company",
      "second-brain-team-name": "Ghost Team",
    },
  });
  active.worker.setTeams([{ id: "team-a", name: "Alpha" }]);

  assert.equal(await active.plugin.syncFile(active.file, true), false);
  assert.equal(active.captureRequests().length, 0);
  assert.ok(active.notices().some((n) => /picker|team|destination/i.test(n)));
  await active.assertFileIntegrity();
});
