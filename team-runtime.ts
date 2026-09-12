export type MemoryWorkspace = "personal" | "company";
export type LegacyWorkspace = MemoryWorkspace | "system";

export interface Destination {
  workspace: MemoryWorkspace;
  teamId?: string;
  teamName?: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  memberCount?: number;
}

export interface DestinationProperties {
  workspace: unknown;
  team: unknown;
  teamName?: unknown;
}

export type ParsedDestination =
  | { kind: "missing" }
  | { kind: "valid"; destination: Destination }
  | { kind: "invalid"; reason: string };

export interface LegacyResolution {
  destination?: Destination;
  reason?: string;
}

export function normalizeTagValues(value: unknown): string[] {
  const values: string[] = [];
  const add = (item: unknown) => {
    if (typeof item !== "string") return;
    for (const part of item.split(",")) {
      const tag = part.trim().replace(/^#/, "");
      if (tag) values.push(tag);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(add);
  } else {
    add(value);
  }

  return Array.from(new Set(values));
}

export function normalizeNoteTags(frontmatterTags: unknown, inlineTags: unknown): string[] {
  return Array.from(new Set([
    ...normalizeTagValues(frontmatterTags),
    ...normalizeTagValues(inlineTags),
  ]));
}

export function parseDestinationProperties(workspace: unknown, team: unknown, name?: unknown): ParsedDestination {
  const hasTeam = typeof team === "string" && team.trim().length > 0;
  const hasName = typeof name === "string" && name.trim().length > 0;

  if (workspace === undefined || workspace === null || workspace === "") {
    if (hasTeam || hasName) {
      return { kind: "invalid", reason: "A team destination requires second-brain-workspace: company." };
    }
    return { kind: "missing" };
  }

  if (workspace === "personal") {
    if (hasTeam || hasName) {
      return { kind: "invalid", reason: "Personal memories cannot have a second-brain-team." };
    }
    return { kind: "valid", destination: { workspace: "personal" } };
  }

  if (workspace !== "company") {
    return { kind: "invalid", reason: "second-brain-workspace must be personal or company." };
  }

  if (!hasTeam && !hasName) {
    return { kind: "invalid", reason: "A company destination requires a team ID or team name." };
  }

  return {
    kind: "valid",
    destination: {
      workspace: "company",
      ...(hasTeam ? { teamId: team.trim() } : {}),
      ...(hasName ? { teamName: name.trim() } : {}),
    },
  };
}

/** Case-insensitive, trimmed name match against the live team list. Pure — no network. */
export type TeamNameResolution =
  | { kind: "found"; team: TeamSummary }
  | { kind: "not-found" }
  | { kind: "ambiguous"; matches: TeamSummary[] };

export function resolveTeamByName(name: string, teams: TeamSummary[]): TeamNameResolution {
  const normalized = name.trim().toLowerCase();
  const matches = teams.filter((team) => team.name.trim().toLowerCase() === normalized);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "found", team: matches[0] };
}

export function destinationEquals(a: Destination, b: Destination): boolean {
  return a.workspace === b.workspace && (a.teamId ?? "") === (b.teamId ?? "");
}

export function destinationLabel(destination: Destination, teams: TeamSummary[]): string {
  if (destination.workspace === "personal") return "Personal";
  return teams.find((team) => team.id === destination.teamId)?.name ?? "Unavailable team";
}

export function destinationToProperties(destination: Destination): DestinationProperties {
  if (destination.workspace === "company") {
    return {
      workspace: "company",
      team: destination.teamId,
      ...(destination.teamName !== undefined ? { teamName: destination.teamName } : {}),
    };
  }
  return { workspace: "personal", team: undefined };
}

export function resolveLegacyDestination(
  workspaces: LegacyWorkspace[],
  teams: TeamSummary[],
): LegacyResolution {
  if (workspaces.length === 0) {
    return { reason: "No tracked memories were found to resolve." };
  }

  if (workspaces.every((workspace) => workspace === "personal")) {
    return { destination: { workspace: "personal" } };
  }

  if (workspaces.every((workspace) => workspace === "company") && teams.length === 1) {
    return { destination: { workspace: "company", teamId: teams[0].id } };
  }

  if (workspaces.includes("system")) {
    return { reason: "This note includes a system memory. Choose a destination before syncing." };
  }

  if (new Set(workspaces).size > 1) {
    return { reason: "This note has memories in multiple destinations. Choose one before syncing." };
  }

  return { reason: "This note's team is ambiguous. Choose a named team before syncing." };
}

export function isValidCaptureResponse(response: { status: number; json: unknown }): response is {
  status: 200;
  json: { ok: true; id: string };
} {
  const json = response.json as { ok?: unknown; id?: unknown } | null;
  return response.status === 200
    && json?.ok === true
    && typeof json.id === "string"
    && json.id.trim().length > 0;
}
