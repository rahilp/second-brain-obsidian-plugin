import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, after } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundleDir = mkdtempSync(join(tmpdir(), "second-brain-team-runtime-tests-"));
const bundlePath = join(bundleDir, "team-runtime.cjs");

buildSync({
  entryPoints: [join(root, "team-runtime.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: bundlePath,
});

const require = createRequire(import.meta.url);
const runtime = require(bundlePath);

after(() => rmSync(bundleDir, { recursive: true, force: true }));

test("tag normalization accepts scalar, comma-separated, arrays, and inline hash forms", () => {
  assert.deepEqual(runtime.normalizeNoteTags(" #brain, project ", ["#brain", "#urgent"]), ["brain", "project", "urgent"]);
  assert.deepEqual(runtime.normalizeTagValues(["one, two", "#two", 4]), ["one", "two"]);
});

test("destination properties are strict and fail closed", () => {
  assert.deepEqual(runtime.parseDestinationProperties(undefined, undefined), { kind: "missing" });
  assert.deepEqual(runtime.parseDestinationProperties("personal", undefined), { kind: "valid", destination: { workspace: "personal" } });
  assert.equal(runtime.parseDestinationProperties("personal", "team-a").kind, "invalid");
  assert.equal(runtime.parseDestinationProperties("company", undefined).kind, "invalid");
  assert.equal(runtime.parseDestinationProperties("other", "team-a").kind, "invalid");
  assert.deepEqual(runtime.parseDestinationProperties("company", " team-a "), { kind: "valid", destination: { workspace: "company", teamId: "team-a" } });
});

test("parseDestinationProperties gains a team-name field: name-only and both-present states parse as valid", () => {
  // Name only, no ID — must not fail closed at the parse layer; resolution happens elsewhere.
  assert.deepEqual(runtime.parseDestinationProperties("company", undefined, "Acme Engineering"), {
    kind: "valid",
    destination: { workspace: "company", teamName: "Acme Engineering" },
  });
  // Both present.
  assert.deepEqual(runtime.parseDestinationProperties("company", "team-a", "Alpha Team"), {
    kind: "valid",
    destination: { workspace: "company", teamId: "team-a", teamName: "Alpha Team" },
  });
  // Neither team nor name — still invalid.
  assert.equal(runtime.parseDestinationProperties("company", undefined, undefined).kind, "invalid");
  assert.equal(runtime.parseDestinationProperties("company", "", "   ").kind, "invalid");
  // A team name on a personal note is just as invalid as a team ID on one.
  assert.equal(runtime.parseDestinationProperties("personal", undefined, "Alpha Team").kind, "invalid");
});

test("resolveTeamByName: one row of the decision table per case — found / not-found / ambiguous, trimmed and case-insensitive", () => {
  const teams = [{ id: "team-a", name: "Alpha Team" }, { id: "team-b", name: "Beta Team" }];

  // Found — case-insensitive, trimmed.
  assert.deepEqual(runtime.resolveTeamByName("  alpha team  ", teams), { kind: "found", team: teams[0] });

  // Not found.
  assert.deepEqual(runtime.resolveTeamByName("Ghost Team", teams), { kind: "not-found" });

  // Ambiguous — matches two or more teams.
  const dup = [{ id: "team-a", name: "Shared Name" }, { id: "team-b", name: "Shared Name" }];
  assert.deepEqual(runtime.resolveTeamByName("shared name", dup), { kind: "ambiguous", matches: dup });
});

test("legacy destination migration only chooses an unambiguous stable team ID", () => {
  const teams = [{ id: "team-a", name: "Alpha" }, { id: "team-b", name: "Beta" }];
  assert.deepEqual(runtime.resolveLegacyDestination(["personal"], teams), { destination: { workspace: "personal" } });
  assert.deepEqual(runtime.resolveLegacyDestination(["company"], [teams[0]]), { destination: { workspace: "company", teamId: "team-a" } });
  assert.match(runtime.resolveLegacyDestination(["company"], teams).reason, /ambiguous|named team/i);
  assert.match(runtime.resolveLegacyDestination(["personal", "company"], teams).reason, /multiple destinations/i);
  assert.match(runtime.resolveLegacyDestination(["system"], teams).reason, /system/i);
});

test("destination labels come from current team names while payloads retain IDs", () => {
  const destination = { workspace: "company", teamId: "team-a" };
  assert.equal(runtime.destinationLabel(destination, [{ id: "team-a", name: "Renamed Alpha" }]), "Renamed Alpha");
  assert.equal(runtime.destinationLabel(destination, [{ id: "team-b", name: "Beta" }]), "Unavailable team");
  assert.deepEqual(runtime.destinationToProperties(destination), { workspace: "company", team: "team-a" });
  assert.deepEqual(runtime.destinationToProperties({ workspace: "personal" }), { workspace: "personal", team: undefined });
});

test("destinationToProperties emits the team-name property when the destination carries one", () => {
  assert.deepEqual(
    runtime.destinationToProperties({ workspace: "company", teamId: "team-a", teamName: "Alpha Team" }),
    { workspace: "company", team: "team-a", teamName: "Alpha Team" },
  );
});

test("capture response requires HTTP 200, ok:true, and a non-empty returned ID", () => {
  assert.equal(runtime.isValidCaptureResponse({ status: 200, json: { ok: true, id: "entry-1" } }), true);
  assert.equal(runtime.isValidCaptureResponse({ status: 200, json: { ok: false, id: "duplicate" } }), false);
  assert.equal(runtime.isValidCaptureResponse({ status: 200, json: { ok: true } }), false);
  assert.equal(runtime.isValidCaptureResponse({ status: 201, json: { ok: true, id: "entry-1" } }), false);
});
