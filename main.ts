import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Menu,
  RequestUrlResponse,
  TFile,
  WorkspaceLeaf,
  requestUrl,
  normalizePath,
  setIcon,
} from "obsidian";
import {
  destinationEquals,
  destinationToProperties,
  isValidCaptureResponse,
  normalizeNoteTags,
  parseDestinationProperties,
  resolveLegacyDestination,
  resolveTeamByName,
  type Destination,
  type LegacyWorkspace,
  type TeamSummary,
} from "./team-runtime";

// ─── Settings ─────────────────────────────────────────────────────────────────

type SyncMode = "all" | "tagged";

interface SecondBrainSettings {
  workerUrl: string;
  authToken: string;
  syncMode: SyncMode;
  syncTag: string;
  autoSync: boolean;
  autoSyncDelay: number;
  chunkSize: number;
  chunkOverlap: number;
  showSyncStatus: boolean;
  lastSyncTime: number | null;
  importFolder: string;
  importTag: string;
  importLimit: number;
  pullOnStartup: boolean;
  importedIds: string[];
  defaultDestination: Destination;
}

const DEFAULT_SETTINGS: SecondBrainSettings = {
  workerUrl: "",
  authToken: "",
  syncMode: "tagged",
  syncTag: "brain",
  autoSync: false,
  autoSyncDelay: 5000,
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: true,
  lastSyncTime: null,
  importFolder: "_Second Brain/Inbox",
  importTag: "obsidian-inbox",
  importLimit: 20,
  pullOnStartup: false,
  importedIds: [],
  defaultDestination: { workspace: "personal" },
};

// ─── Chunking ─────────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2) end = breakPoint + 1;
    }

    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
    if (start >= text.length) break;
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── API types ────────────────────────────────────────────────────────────────

interface ApiResponse {
  ok?: boolean;
  id?: string;
  error?: string;
}

interface TeamWorkspacesResponse {
  ok?: boolean;
  teams?: Array<{ id?: unknown; name?: unknown; memberCount?: unknown }>;
  admin?: boolean;
  error?: string;
}

interface EntryInspection {
  id: string;
  workspace: LegacyWorkspace;
  canEdit: boolean;
}

interface SyncSnapshot {
  workerUrl: string;
  authToken: string;
  destination: Destination;
  // The raw (unresolved) destination as read from frontmatter at the top of this sync,
  // before name/ID decision-table resolution. Used to detect real concurrent edits without
  // mistaking our own resolution (adopt/backfill/rename/reroute) for staleness.
  originalDestination?: Destination;
  settingsGeneration: number;
  destinationRevision: number;
}

interface PendingSyncProgress {
  snapshot: SyncSnapshot;
  ids: string[];
  retiredIds: string[];
}

// Structural equality of two unresolved destinations (workspace + teamId + teamName),
// used only to detect concurrent frontmatter edits — unlike destinationEquals (teamId-only),
// this must also notice a hand-edited name so a race during resolution isn't missed.
function rawDestinationEquals(a: Destination, b: Destination): boolean {
  return a.workspace === b.workspace
    && (a.teamId ?? "") === (b.teamId ?? "")
    && (a.teamName ?? "") === (b.teamName ?? "");
}

class StaleSyncError extends Error {
  constructor(message = "Sync stopped because the account or note destination changed. Retry to use the new settings.") {
    super(message);
    this.name = "StaleSyncError";
  }
}

interface MemoryEntry {
  id?: unknown;
  content?: unknown;
  tags?: unknown;
  source?: unknown;
  created_at?: unknown;
}

interface ListApiResponse {
  items?: MemoryEntry[];
  entries?: MemoryEntry[];
  memories?: MemoryEntry[];
  data?: MemoryEntry[];
}

interface RecallResult {
  id?: unknown;
  content?: unknown;
  score?: unknown;
  tags?: unknown;
  source?: unknown;
  created_at?: unknown;
  updated?: unknown;
}

interface RecallApiResponse {
  ok?: boolean;
  results?: RecallResult[];
  insight?: string;
  error?: string;
}

interface NormalizedRecallResult {
  id: string;
  title: string;
  snippet: string;
  content: string;
  tags: string[];
  score: number | null;
  createdAt: string | null;
}

const VIEW_TYPE_SEARCH = "second-brain-search";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class SecondBrainPlugin extends Plugin {
  settings: SecondBrainSettings;
  statusBar: HTMLElement | null = null;
  // number (browser) rather than NodeJS.Timeout — we use window.setTimeout
  debounceTimers: Map<string, number> = new Map();
  syncingFiles: Set<string> = new Set();
  destinationRevisions: Map<string, number> = new Map();
  settingsGeneration = 0;
  teamCache: TeamSummary[] | null = null;
  teamCacheKey = "";
  teamRequestGeneration = 0;
  teamLoadPromise: Promise<TeamSummary[]> | null = null;
  teamEndpointUnsupported = false;
  teamLoadError = "";
  frontmatterWrites: Set<string> = new Set();
  frontmatterWriteTimers: Map<string, number> = new Map();
  pendingSyncProgress: Map<string, PendingSyncProgress> = new Map();
  isImporting = false;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_SEARCH, (leaf) => new SearchView(leaf, this));

    this.addRibbonIcon("search", "Search second brain memories", () => {
      void this.activateSearchView();
    });

    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }

    this.addRibbonIcon("brain", "Sync current note to second brain", () => {
      void this.syncActiveNote();
    });

    // FIX: command names must not include the plugin name (rule 15)
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      editorCallback: (_editor: Editor, view: MarkdownView) => {
        void this.syncFile(view.file!);
      },
    });

    this.addCommand({
      id: "sync-all-tagged",
      name: "Sync all tagged notes",
      callback: () => this.syncAllTagged(),
    });

    this.addCommand({
      id: "import-memories",
      name: "Import memories",
      callback: async () => {
        await this.importMemories(false);
      },
    });

    this.addCommand({
      id: "search-memories",
      name: "Search memories",
      callback: () => {
        void this.activateSearchView();
      },
    });

    this.addCommand({
      id: "set-memory-destination",
      name: "Set memory destination",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Open a Markdown note to set its memory destination.");
          return;
        }
        new DestinationModal(this.app, this, file).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) => {
          item.setTitle("Set memory destination").setIcon("share-2").onClick(() => {
            new DestinationModal(this.app, this, file).open();
          });
        });
      })
    );

    // FIX: always register modify event; gate on this.settings.autoSync inside the
    // handler so toggling auto-sync in settings takes effect immediately without
    // requiring an Obsidian restart.
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (this.frontmatterWrites.has(file.path)) {
          this.frontmatterWrites.delete(file.path);
          const timer = this.frontmatterWriteTimers.get(file.path);
          if (timer) window.clearTimeout(timer);
          this.frontmatterWriteTimers.delete(file.path);
          return;
        }
        this.destinationRevisions.set(file.path, (this.destinationRevisions.get(file.path) ?? 0) + 1);
        if (this.settings.autoSync) {
          await this.debouncedSyncIfTagged(file);
        }
      })
    );

    // Re-sync on rename so the stored title stays current in Second Brain.
    this.registerEvent(
      this.app.vault.on("rename", async (file, _oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          await this.syncIfTagged(file, true);
        }
      })
    );

    if (this.settings.pullOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.importMemories(true).catch((e) => {
          console.error("Second Brain automatic import failed:", e);
          new Notice("Automatic memory import failed.");
        });
      });
    }

    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
  }

  async activateSearchView() {
    const { workspace } = this.app;

    const existing = workspace.getLeavesOfType(VIEW_TYPE_SEARCH);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_SEARCH, active: true });
    await workspace.revealLeaf(leaf);
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
    for (const timer of this.frontmatterWriteTimers.values()) window.clearTimeout(timer);
    this.frontmatterWriteTimers.clear();
    this.teamRequestGeneration++;
  }

  // ── Sync methods ────────────────────────────────────────────────────────────

  async syncActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note open"); return; }
    await this.syncFile(file);
  }

  async debouncedSyncIfTagged(file: TFile) {
    if (this.syncingFiles.has(file.path)) return;

    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(file.path);
      void this.syncIfTagged(file);
    }, this.settings.autoSyncDelay);

    this.debounceTimers.set(file.path, timer);
  }

  async syncIfTagged(file: TFile, silent = false) {
    if (this.settings.syncMode === "all") {
      await this.syncFile(file, silent);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const inlineTags = (cache?.tags ?? []).map((t) => t.tag);
    const allTags = normalizeNoteTags(cache?.frontmatter?.tags, inlineTags);
    if (!allTags.includes(this.settings.syncTag.replace(/^#/, ""))) return;
    await this.syncFile(file, silent);
  }

  async syncAllTagged() {
    if (!this.validateSettings()) return;

    const files = this.app.vault.getMarkdownFiles();
    const tagged = this.settings.syncMode === "all"
      ? files
      : files.filter((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        const inlineTags = (cache?.tags ?? []).map((t) => t.tag);
        const tags = normalizeNoteTags(cache?.frontmatter?.tags, inlineTags);
        return tags.includes(this.settings.syncTag.replace(/^#/, ""));
      });

    if (!tagged.length) {
      new Notice(this.settings.syncMode === "all"
        ? "No notes found in vault"
        : `No notes tagged with "${this.settings.syncTag}" found`);
      return;
    }

    new Notice(`Syncing ${tagged.length} notes...`);
    let synced = 0, failed = 0;

    for (const file of tagged) {
      const ok = await this.syncFile(file, true);
      if (ok) synced++; else failed++;
      await new Promise((r) => window.setTimeout(r, 300));
    }

    if (failed === 0) {
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this.updateStatusBar();
    }

    new Notice(`Second Brain: ${synced} synced${failed ? `, ${failed} failed` : ""}`);
  }

  async syncFile(file: TFile, silent = false): Promise<boolean> {
    if (!this.validateSettings()) return false;

    if (this.syncingFiles.has(file.path)) return false;
    this.syncingFiles.add(file.path);

    try {
      const raw = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter ?? {};

      const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
      const title = file.basename;
      const noteTags = normalizeNoteTags(
        frontmatter.tags,
        (cache?.tags ?? []).map((tag) => tag.tag),
      );

      // Normalize stored IDs — support legacy single string and new array format.
      const existingIds = this.parseIds(frontmatter["second-brain-id"]);
      const retiredIds = this.parseIds(frontmatter["second-brain-retired-ids"]);
      const allTrackedIds = Array.from(new Set([...existingIds, ...retiredIds]));

      const workerUrl = this.normalizeWorkerUrl(this.settings.workerUrl);
      const authToken = this.settings.authToken;
      const settingsGeneration = this.settingsGeneration;
      const destinationRevision = this.destinationRevisions.get(file.path) ?? 0;
      const originalParsed = parseDestinationProperties(
        frontmatter["second-brain-workspace"],
        frontmatter["second-brain-team"],
        frontmatter["second-brain-team-name"],
      );
      const destination = await this.resolveDestination(file, frontmatter, allTrackedIds, workerUrl, authToken);
      const snapshot: SyncSnapshot = {
        workerUrl,
        authToken,
        destination,
        originalDestination: originalParsed.kind === "valid" ? originalParsed.destination : undefined,
        settingsGeneration,
        destinationRevision,
      };
      this.assertSnapshotCurrent(snapshot, file);

      // Pin the destination before any move/capture. This is a local vault write
      // guarded below so it cannot trigger an automatic sync loop.
      await this.persistDestination(file, snapshot);

      const fullContent = `${title}\n\n${body}`;
      const chunks = chunkText(fullContent, this.settings.chunkSize, this.settings.chunkOverlap);
      const capturedTags = [...new Set([...noteTags, "obsidian", file.parent?.name ?? ""].filter(Boolean))];
      const progressIds = existingIds.slice(0, chunks.length);
      const activeExistingCount = Math.min(existingIds.length, chunks.length);
      const shrinkRetiredIds = Array.from(new Set([
        ...retiredIds,
        ...existingIds.slice(chunks.length),
      ]));

      // /share is idempotent and must happen before any content update/new
      // capture. Retired IDs stay tracked so shrinking a note never leaves a
      // known chunk behind in an old shared destination.
      for (const id of allTrackedIds) {
        await this.shareEntry(id, snapshot, file);
      }

      for (let i = 0; i < chunks.length; i++) {
        this.assertSnapshotCurrent(snapshot, file);
        const chunkContent = chunks.length > 1
          ? `${chunks[i]} [chunk ${i + 1}/${chunks.length}]`
          : chunks[i];

        if (i < existingIds.length) {
          const response = await this.requestForSnapshot(snapshot, file, {
            url: `${snapshot.workerUrl}/update`,
            method: "POST",
            headers: {
              Authorization: `Bearer ${snapshot.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: existingIds[i], content: chunkContent }),
            throw: false,
          });

          const updateJson = response.json as ApiResponse;
          if (response.status !== 200 || !updateJson?.ok) {
            this.notifySyncError(silent, updateJson?.error ?? `Server returned ${response.status}`);
            return false;
          }
          progressIds[i] = existingIds[i];
        } else {
          const response = await this.requestForSnapshot(snapshot, file, {
            url: `${snapshot.workerUrl}/capture`,
            method: "POST",
            headers: {
              Authorization: `Bearer ${snapshot.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: chunkContent,
              source: "obsidian",
              tags: capturedTags,
              workspace: snapshot.destination.workspace,
              ...(snapshot.destination.workspace === "company"
                ? { team: snapshot.destination.teamId }
                : {}),
            }),
            throw: false,
          }, false);

          const captureResponse = { status: response.status, json: response.json as unknown };
          if (!isValidCaptureResponse(captureResponse)) {
            const captureJson = captureResponse.json as ApiResponse;
            this.notifySyncError(silent, captureJson?.error ?? `Capture did not return a valid memory ID (HTTP ${response.status}).`);
            return false;
          }
          progressIds[i] = captureResponse.json.id;
          this.pendingSyncProgress.set(file.path, {
            snapshot,
            ids: this.progressIdsForRetry(existingIds, progressIds, activeExistingCount, i),
            retiredIds: shrinkRetiredIds,
          });
          this.assertSnapshotCurrent(snapshot, file);
        }

        await this.persistSyncProgress(
          file,
          this.progressIdsForRetry(existingIds, progressIds, activeExistingCount, i),
          snapshot,
          shrinkRetiredIds,
          false,
        );

        if (i < chunks.length - 1) {
          await new Promise((r) => window.setTimeout(r, 200));
        }
      }

      await this.persistSyncProgress(file, progressIds, snapshot, shrinkRetiredIds, true);
      this.pendingSyncProgress.delete(file.path);

      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this.updateStatusBar();

      if (!silent) {
        const isUpdate = existingIds.length > 0;
        const chunkNote = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
        new Notice(isUpdate
          ? `✓ Updated "${title}" in Second Brain${chunkNote}`
          : `✓ Saved "${title}" to Second Brain${chunkNote}`);
      }

      return true;
    } catch (e) {
      const message = e instanceof StaleSyncError
        ? e.message
        : "Second Brain: sync failed. Check the Worker connection and retry.";
      if (!silent) new Notice(message);
      return false;
    } finally {
      this.syncingFiles.delete(file.path);
    }
  }

  parseIds(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  }

  progressIdsForRetry(
    existingIds: string[],
    progressIds: string[],
    activeExistingCount: number,
    completedIndex: number,
  ): string[] {
    const ids = existingIds.slice(0, activeExistingCount);
    for (let i = activeExistingCount; i <= completedIndex; i++) {
      if (progressIds[i]) ids[i] = progressIds[i];
    }
    return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  notifySyncError(silent: boolean, error: string) {
    if (!silent) new Notice(`Second Brain error: ${error}`);
  }

  connectionKey(): string {
    return `${this.normalizeWorkerUrl(this.settings.workerUrl)}\n${this.settings.authToken}`;
  }

  invalidateTeamCache() {
    this.teamRequestGeneration++;
    this.teamCache = null;
    this.teamCacheKey = "";
    this.teamLoadPromise = null;
    this.teamEndpointUnsupported = false;
    this.teamLoadError = "";
  }

  async loadTeams(force = false): Promise<TeamSummary[]> {
    const key = this.connectionKey();
    if (!force && this.teamCache && this.teamCacheKey === key) return this.teamCache;
    if (!force && this.teamLoadPromise && this.teamCacheKey === key) return this.teamLoadPromise;

    const requestGeneration = ++this.teamRequestGeneration;
    const workerUrl = this.normalizeWorkerUrl(this.settings.workerUrl);
    const authToken = this.settings.authToken;
    this.teamCacheKey = key;
    this.teamEndpointUnsupported = false;
    this.teamLoadError = "";

    const promise = requestUrl({
      url: `${workerUrl}/team/workspaces`,
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
      throw: false,
    }).then((response) => {
      if (requestGeneration !== this.teamRequestGeneration || key !== this.connectionKey()) {
        throw new StaleSyncError("Team lookup became stale because the Worker connection changed. Retry.");
      }
      if (response.status === 404) {
        // A pre-team worker may not expose this route. This is the only
        // capability fallback; auth/network failures remain hard failures.
        this.teamEndpointUnsupported = true;
        this.teamCache = [];
        return [];
      }
      if (response.status !== 200) {
        const message = response.status === 401
          ? "Team lookup was unauthorized. Check the auth token."
          : `Team lookup failed (HTTP ${response.status}).`;
        throw new Error(message);
      }

      const data = response.json as TeamWorkspacesResponse;
      if (!data || data.ok !== true || !Array.isArray(data.teams)) {
        throw new Error("Team lookup returned an invalid response. Retry after checking the Worker.");
      }
      const teams: TeamSummary[] = [];
      for (const rawTeam of data.teams) {
        if (typeof rawTeam?.id !== "string" || !rawTeam.id.trim() || typeof rawTeam.name !== "string" || !rawTeam.name.trim()) {
          throw new Error("Team lookup returned a malformed team. Retry after checking the Worker.");
        }
        teams.push({
          id: rawTeam.id.trim(),
          // Name is kept byte-exact (not trimmed) — it's a human-readable display value
          // that round-trips into frontmatter, and stripping whitespace here would silently
          // rewrite whatever the server considers the team's real name.
          name: rawTeam.name,
          ...(typeof rawTeam.memberCount === "number" ? { memberCount: rawTeam.memberCount } : {}),
        });
      }
      this.teamCache = teams;
      this.teamCacheKey = key;
      return teams;
    }).catch((error) => {
      if (requestGeneration === this.teamRequestGeneration && key === this.connectionKey()) {
        this.teamLoadError = error instanceof Error ? error.message : "Team lookup failed. Retry.";
      }
      throw error;
    }).finally(() => {
      if (this.teamLoadPromise === promise) this.teamLoadPromise = null;
    });

    this.teamLoadPromise = promise;
    return promise;
  }

  async inspectEntry(id: string, credentials: { workerUrl: string; authToken: string }): Promise<EntryInspection> {
    const response = await requestUrl({
      url: `${credentials.workerUrl}/entry?id=${encodeURIComponent(id)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${credentials.authToken}`, Accept: "application/json" },
      throw: false,
    });
    const data = response.json as { ok?: unknown; entry?: { id?: unknown; workspace?: unknown; can_edit?: unknown }; error?: string };
    const workspace = data?.entry?.workspace;
    if (response.status !== 200 || data?.ok !== true || typeof data?.entry?.id !== "string" ||
      (workspace !== "personal" && workspace !== "company" && workspace !== "system") ||
      typeof data.entry.can_edit !== "boolean") {
      throw new Error(data?.error ?? `Could not inspect tracked memory ${id}.`);
    }
    return { id, workspace, canEdit: data.entry.can_edit };
  }

  async resolveDestination(
    _file: TFile,
    frontmatter: Record<string, unknown>,
    existingIds: string[],
    workerUrl: string,
    authToken: string,
  ): Promise<Destination> {
    const parsed = parseDestinationProperties(
      frontmatter["second-brain-workspace"],
      frontmatter["second-brain-team"],
      frontmatter["second-brain-team-name"],
    );
    const credentials = { workerUrl, authToken };

    if (parsed.kind === "invalid") throw new Error(`Second Brain: ${parsed.reason}`);
    if (parsed.kind === "valid") {
      if (parsed.destination.workspace === "personal") return parsed.destination;
      const teams = await this.loadTeams();
      if (this.teamEndpointUnsupported) {
        throw new Error("Second Brain: named team destinations are unavailable on this Worker. Retry after upgrading it.");
      }
      return await this.resolveCompanyDestination(parsed.destination, teams);
    }

    if (existingIds.length === 0) {
      const configured = this.settings.defaultDestination;
      const defaultParsed = parseDestinationProperties(configured?.workspace, configured?.teamId, configured?.teamName);
      if (defaultParsed.kind !== "valid") {
        throw new Error("Second Brain: choose a valid default destination in settings before syncing.");
      }
      if (defaultParsed.destination.workspace === "personal") return defaultParsed.destination;
      const teams = await this.loadTeams();
      if (this.teamEndpointUnsupported) {
        throw new Error("Second Brain: the configured team is unavailable. Choose a named team in settings and retry.");
      }
      return await this.resolveCompanyDestination(defaultParsed.destination, teams);
    }

    const inspected = await Promise.all(existingIds.map((id) => this.inspectEntry(id, credentials)));
    const resolutionTeams = inspected.some((entry) => entry.workspace === "company")
      ? await this.loadTeams()
      : [];
    const resolution = resolveLegacyDestination(
      inspected.map((entry) => entry.workspace),
      resolutionTeams,
    );
    if (!resolution.destination) throw new Error(`Second Brain: ${resolution.reason ?? "Choose a destination before syncing."}`);
    if (inspected.some((entry) => !entry.canEdit)) {
      throw new Error("Second Brain: at least one tracked memory cannot be edited by this account. Choose a different note or account.");
    }
    if (resolution.destination.workspace === "company" && this.teamEndpointUnsupported) {
      throw new Error("Second Brain: named team destinations are unavailable on this Worker. Retry after upgrading it.");
    }
    return resolution.destination;
  }

  /**
   * Applies the name/ID decision table for a company destination. The team NAME is
   * client-side, human-entered, and never trustworthy on its own — the team ID is what
   * reaches the network. Resolution order: ambiguous name fails closed first (regardless
   * of ID); a resolved name is always authoritative (covers adopt / no-op / re-route, since
   * the caller shares tracked IDs to whatever destination this returns); otherwise fall back
   * to the ID; if neither resolves, fail closed before any capture request.
   *
   * Once an ID is chosen, its display name is re-fetched with a forced (non-cached) team
   * lookup rather than trusted from `teams` — a name matched or an ID validated moments ago
   * can already be stale if the team was renamed server-side in between.
   */
  async resolveCompanyDestination(candidate: Destination, teams: TeamSummary[]): Promise<Destination> {
    const { teamId, teamName } = candidate;
    const nameResolution = teamName ? resolveTeamByName(teamName, teams) : null;

    if (nameResolution?.kind === "ambiguous") {
      const ids = nameResolution.matches.map((team) => team.id).join(", ");
      const message = `Second Brain: team name "${teamName}" is a collision — it matches multiple teams (${ids}). Resolve it with the destination picker.`;
      new Notice(message);
      throw new Error(message);
    }

    const resolvedId = nameResolution?.kind === "found"
      ? nameResolution.team.id
      : teams.find((team) => team.id === teamId)?.id;

    if (!resolvedId) {
      const message = teamName
        ? `Second Brain: team name "${teamName}" doesn't match any current team. Choose a destination with the picker.`
        : "Second Brain: this note's team is unavailable. Choose a current team before syncing.";
      new Notice(message);
      throw new Error(message);
    }

    const freshTeams = await this.loadTeams(true);
    const freshTeam = freshTeams.find((team) => team.id === resolvedId);
    if (!freshTeam) {
      const message = "Second Brain: this note's team is unavailable. Choose a current team before syncing.";
      new Notice(message);
      throw new Error(message);
    }
    return { workspace: "company", teamId: freshTeam.id, teamName: freshTeam.name };
  }

  assertSnapshotCurrent(snapshot: SyncSnapshot, file: TFile) {
    if (snapshot.settingsGeneration !== this.settingsGeneration ||
      snapshot.workerUrl !== this.normalizeWorkerUrl(this.settings.workerUrl) ||
      snapshot.authToken !== this.settings.authToken ||
      snapshot.destinationRevision !== (this.destinationRevisions.get(file.path) ?? 0)) {
      throw new StaleSyncError();
    }
  }

  async requestForSnapshot(
    snapshot: SyncSnapshot,
    file: TFile,
    request: Parameters<typeof requestUrl>[0],
    checkAfter = true,
  ): Promise<RequestUrlResponse> {
    this.assertSnapshotCurrent(snapshot, file);
    const response = await requestUrl(request);
    if (checkAfter) this.assertSnapshotCurrent(snapshot, file);
    return response;
  }

  async shareEntry(id: string, snapshot: SyncSnapshot, file: TFile) {
    const response = await this.requestForSnapshot(snapshot, file, {
      url: `${snapshot.workerUrl}/share`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${snapshot.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id,
        workspace: snapshot.destination.workspace,
        ...(snapshot.destination.workspace === "company" ? { team: snapshot.destination.teamId } : {}),
      }),
      throw: false,
    });
    const data = response.json as ApiResponse;
    if (response.status !== 200 || data?.ok !== true) {
      throw new Error(data?.error ?? `Could not move tracked memory ${id}.`);
    }
  }

  async persistDestination(file: TFile, snapshot: SyncSnapshot) {
    this.assertSnapshotCurrent(snapshot, file);
    await this.processFrontMatterGuarded(file, (fm) => {
      const current = parseDestinationProperties(fm["second-brain-workspace"], fm["second-brain-team"], fm["second-brain-team-name"]);
      // Compare against the RAW destination read at the top of this sync (before
      // name/ID resolution), not the resolved one — resolution intentionally rewrites
      // teamId/teamName (adopt/backfill/rename/reroute), which must not look like a race.
      const stale = current.kind === "invalid"
        ? true
        : current.kind === "valid"
          ? !snapshot.originalDestination || !rawDestinationEquals(current.destination, snapshot.originalDestination)
          : !!snapshot.originalDestination || (this.destinationRevisions.get(file.path) ?? 0) !== snapshot.destinationRevision;
      if (stale) throw new StaleSyncError();
      const properties = destinationToProperties(snapshot.destination);
      fm["second-brain-workspace"] = properties.workspace;
      if (snapshot.destination.workspace === "company") {
        fm["second-brain-team"] = properties.team;
        if (properties.teamName !== undefined) fm["second-brain-team-name"] = properties.teamName;
        else delete fm["second-brain-team-name"];
      } else {
        delete fm["second-brain-team"];
        delete fm["second-brain-team-name"];
      }
    });
  }

  async setNoteDestination(file: TFile, destination: Destination) {
    let teamName: string | undefined;
    if (destination.workspace === "company") {
      const teams = await this.loadTeams();
      const team = destination.teamId ? teams.find((t) => t.id === destination.teamId) : undefined;
      if (this.teamEndpointUnsupported || !team) {
        throw new Error("That named team is no longer available. Refresh team membership and try again.");
      }
      teamName = team.name;
    }
    this.destinationRevisions.set(file.path, (this.destinationRevisions.get(file.path) ?? 0) + 1);
    await this.processFrontMatterGuarded(file, (fm) => {
      fm["second-brain-workspace"] = destination.workspace;
      if (destination.workspace === "company") {
        fm["second-brain-team"] = destination.teamId;
        fm["second-brain-team-name"] = teamName;
      } else {
        delete fm["second-brain-team"];
        delete fm["second-brain-team-name"];
      }
    });
  }

  async persistSyncProgress(
    file: TFile,
    ids: string[],
    snapshot: SyncSnapshot,
    retiredIds: string[],
    complete: boolean,
  ) {
    this.assertSnapshotCurrent(snapshot, file);
    await this.processFrontMatterGuarded(file, (fm) => {
      const current = parseDestinationProperties(fm["second-brain-workspace"], fm["second-brain-team"], fm["second-brain-team-name"]);
      if (current.kind !== "valid" || !destinationEquals(current.destination, snapshot.destination)) {
        throw new StaleSyncError();
      }
      if (snapshot.destination.workspace === "company" && snapshot.destination.teamName !== undefined) {
        fm["second-brain-team-name"] = snapshot.destination.teamName;
      }
      if (ids.length > 0) {
        fm["second-brain-id"] = ids.length === 1 ? ids[0] : ids;
      }
      if (retiredIds.length > 0) {
        fm["second-brain-retired-ids"] = retiredIds.length === 1 ? retiredIds[0] : retiredIds;
      } else {
        delete fm["second-brain-retired-ids"];
      }
      if (complete) {
        const now = new Date();
        const date = now.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
        const time = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
        fm["second-brain-synced"] = `${date} - ${time}`;
      }
    });
  }

  async processFrontMatterGuarded(file: TFile, callback: (fm: Record<string, unknown>) => void) {
    this.frontmatterWrites.add(file.path);
    const existingTimer = this.frontmatterWriteTimers.get(file.path);
    if (existingTimer) window.clearTimeout(existingTimer);
    this.frontmatterWriteTimers.set(file.path, window.setTimeout(() => {
      this.frontmatterWrites.delete(file.path);
      this.frontmatterWriteTimers.delete(file.path);
    }, 2500));
    try {
      await this.app.fileManager.processFrontMatter(file, callback);
    } catch (error) {
      this.frontmatterWrites.delete(file.path);
      const timer = this.frontmatterWriteTimers.get(file.path);
      if (timer) window.clearTimeout(timer);
      this.frontmatterWriteTimers.delete(file.path);
      throw error;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  validateSettings(): boolean {
    if (!this.settings.workerUrl) {
      new Notice("Second brain: worker URL not set. Go to settings to configure.");
      return false;
    }
    if (!this.settings.authToken) {
      new Notice("Second brain: auth token not set. Go to settings to configure.");
      return false;
    }
    return true;
  }

  updateStatusBar() {
    if (!this.statusBar) return;
    if (this.settings.lastSyncTime) {
      const date = new Date(this.settings.lastSyncTime);
      this.statusBar.setText(`Brain: ${date.toLocaleTimeString()}`);
    } else {
      this.statusBar.setText("Brain: never synced");
    }
  }

  // ── Import helpers ─────────────────────────────────────────────────────────

  normalizeWorkerUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
  }

  parseMemoryTags(tagsField: unknown): string[] {
    let rawTags: string[] = [];

    if (Array.isArray(tagsField)) {
      rawTags = tagsField.map(t => typeof t === "string" ? t.trim() : "").filter(Boolean);
    } else if (typeof tagsField === "string") {
      const trimmed = tagsField.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            rawTags = parsed.map(t => typeof t === "string" ? t.trim() : "").filter(Boolean);
          } else {
            rawTags = [trimmed];
          }
        } catch {
          rawTags = trimmed.split(",").map(t => t.trim()).filter(Boolean);
        }
      } else {
        rawTags = trimmed.split(",").map(t => t.trim()).filter(Boolean);
      }
    }

    return Array.from(new Set(rawTags));
  }

  sanitizeFileName(input: string): string {
    if (!input || !input.trim()) return "Untitled Memory";

    let clean = input
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    clean = clean.replace(/\.+$/, "").trim();

    if (clean.length > 100) {
      clean = clean.slice(0, 100).trim();
    }

    return clean || "Untitled Memory";
  }

  generateMemoryTitle(content: string, id: string): string {
    const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
    let titleCandidate = "";

    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine.startsWith("#")) {
        titleCandidate = firstLine.replace(/^#+\s*/, "");
      } else {
        titleCandidate = content.replace(/[\r\n]+/g, " ").trim();
        if (titleCandidate.length > 50) {
          titleCandidate = titleCandidate.slice(0, 50);
        }
      }
    }

    const sanitized = this.sanitizeFileName(titleCandidate);
    if (sanitized === "Untitled Memory") {
      return `Memory-${id.slice(0, 8)}`;
    }
    return sanitized;
  }

  getAvailableFilePath(folderPath: string, title: string): string {
    const cleanFolder = folderPath.replace(/\/$/, "");
    let basePath = `${cleanFolder}/${title}.md`;
    let file = this.app.vault.getAbstractFileByPath(normalizePath(basePath));

    if (!file) {
      return normalizePath(basePath);
    }

    let counter = 1;
    while (file) {
      basePath = `${cleanFolder}/${title} (${counter}).md`;
      file = this.app.vault.getAbstractFileByPath(normalizePath(basePath));
      counter++;
    }

    return normalizePath(basePath);
  }

  async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized || normalized === "/" || normalized === ".") return;

    const parts = normalized.split("/");
    let currentPath = "";

    for (const part of parts) {
      if (!part) continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      const fileOrFolder = this.app.vault.getAbstractFileByPath(currentPath);
      if (fileOrFolder) {
        if (fileOrFolder instanceof TFile) {
          throw new Error(`Path "${currentPath}" exists but is a file, not a directory.`);
        }
      } else {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  memoryAlreadyImported(memoryId: string): boolean {
    return this.settings.importedIds?.includes(memoryId) ?? false;
  }

  async importMemories(silent = false): Promise<void> {
    if (this.isImporting) {
      if (!silent) new Notice("An import operation is already in progress.");
      return;
    }

    if (!this.settings.workerUrl) {
      if (!silent) new Notice("Worker URL is not configured.");
      return;
    }
    if (!this.settings.authToken) {
      if (!silent) new Notice("Auth token is not configured.");
      return;
    }

    this.isImporting = true;
    if (!silent) new Notice("Starting import from second brain...");

    try {
      const workerUrl = this.normalizeWorkerUrl(this.settings.workerUrl);
      const authToken = this.settings.authToken;

      // Fallbacks
      const importLimit = typeof this.settings.importLimit === "number" && this.settings.importLimit >= 1
        ? this.settings.importLimit
        : 20;
      const importTag = this.settings.importTag?.trim() || "obsidian-inbox";
      const importFolder = this.settings.importFolder?.trim() || "_Second Brain/Inbox";

      const url = `${workerUrl}/list?n=${importLimit}&tag=${encodeURIComponent(importTag)}`;

      const response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
        throw: false,
      });

      if (response.status !== 200) {
        let errorMsg = `Server returned ${response.status}`;
        if (response.status === 401) {
          errorMsg = "Unauthorized. Please check your auth token.";
        }
        if (!silent) new Notice(`Second Brain import failed: ${errorMsg}`);
        return;
      }

      const data = response.json as MemoryEntry[] | ListApiResponse;
      let memories: MemoryEntry[] = [];

      if (Array.isArray(data)) {
        memories = data;
      } else if (data && typeof data === "object") {
        if (Array.isArray(data.items)) {
          memories = data.items;
        } else if (Array.isArray(data.entries)) {
          memories = data.entries;
        } else if (Array.isArray(data.memories)) {
          memories = data.memories;
        } else if (Array.isArray(data.data)) {
          memories = data.data;
        } else {
          if (!silent) new Notice("Invalid response format: No array of memories found.");
          return;
        }
      } else {
        if (!silent) new Notice("Invalid response format: Response is not JSON.");
        return;
      }

      let importedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let settingsChanged = false;

      // Ensure destination folder exists
      await this.ensureFolderExists(importFolder);

      for (const item of memories) {
        const id = item?.id;
        const content = item?.content;

        if (!id || !content || typeof id !== "string" || typeof content !== "string") {
          continue;
        }

        // Parse tags
        const rawTags = this.parseMemoryTags(item.tags);

        // Client-side tag filtering
        if (importTag && !rawTags.includes(importTag)) {
          skippedCount++;
          continue;
        }

        // Check if already imported (uses in-memory cache only — no vault scan)
        if (this.memoryAlreadyImported(id)) {
          skippedCount++;
          continue;
        }

        try {
          // Generate title
          const title = this.generateMemoryTitle(content, id);
          const path = this.getAvailableFilePath(importFolder, title);

          // Escaping double quotes in YAML fields
          const cleanId = id.replace(/"/g, '\\"');
          const source = (typeof item.source === "string") ? item.source.replace(/"/g, '\\"') : "external-memory";
          const createdAt = this.formatExternalValue(item.created_at).replace(/"/g, '\\"');
          const importedAt = new Date().toISOString();

          // Build markdown content
          const tagsYaml = rawTags.length > 0
            ? "\ntags:\n" + rawTags.map(t => `  - ${t}`).join("\n")
            : "";

          const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
          const startsWithSameHeading = firstLine.startsWith("#") &&
            firstLine.replace(/^#+\s*/, "").trim() === title;

          const frontmatter = `---
external_memory_id: "${cleanId}"
external_memory_source: "${source}"
external_memory_created_at: "${createdAt}"
imported_at: "${importedAt}"${tagsYaml}
---`;

          const body = startsWithSameHeading ? `\n\n${content}` : `\n\n# ${title}\n\n${content}`;
          const fileContent = frontmatter + body;

          // Write to vault
          await this.app.vault.create(path, fileContent);

          // Add to importedIds cache
          if (!this.settings.importedIds.includes(id)) {
            this.settings.importedIds.push(id);
            settingsChanged = true;
          }

          importedCount++;
        } catch (itemError) {
          console.error(`Failed to import memory ID ${id}:`, itemError);
          failedCount++;
        }
      }

      if (settingsChanged) {
        await this.saveSettings();
      }

      if (importedCount > 0) {
        let msg = `Imported ${importedCount} memory/memories.`;
        if (skippedCount > 0) msg += ` ${skippedCount} skipped.`;
        if (failedCount > 0) msg += ` ${failedCount} failed.`;
        new Notice(msg);
      } else {
        if (!silent) {
          let msg = "No new memories to import.";
          if (skippedCount > 0) msg += ` ${skippedCount} skipped.`;
          if (failedCount > 0) msg += ` ${failedCount} failed.`;
          new Notice(msg);
        }
      }
    } catch (e) {
      console.error("Import memories critical error:", e);
      if (!silent) new Notice("Second brain import failed: check console logs for details.");
    } finally {
      this.isImporting = false;
    }
  }

  // ── Search / recall ─────────────────────────────────────────────────────────

  async recallMemories(query: string, topK = 5): Promise<
    | { ok: true; results: NormalizedRecallResult[]; insight: string | null }
    | { ok: false; error: string }
  > {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { ok: false, error: "Please enter a search query." };
    }

    if (!this.settings.workerUrl) {
      return { ok: false, error: "Worker URL is not configured. Go to Settings to configure." };
    }
    if (!this.settings.authToken) {
      return { ok: false, error: "Auth token is not configured. Go to Settings to configure." };
    }

    const workerUrl = this.normalizeWorkerUrl(this.settings.workerUrl);
    const authToken = this.settings.authToken;
    // topK is clamped server-side to 1-20; clamp client-side too so the intent is clear.
    const clampedTopK = Math.min(20, Math.max(1, Math.floor(topK)));
    const url = `${workerUrl}/recall?query=${encodeURIComponent(trimmedQuery)}&topK=${clampedTopK}`;

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
        throw: false,
      });
    } catch (e) {
      console.error("Second Brain recall request failed:", e);
      return { ok: false, error: "Could not reach the Second Brain Worker. Check the Worker URL and your connection." };
    }

    if (response.status !== 200) {
      let errorMsg = `Server returned ${response.status}`;
      if (response.status === 400) {
        errorMsg = "Search query was empty or invalid.";
      } else if (response.status === 401) {
        errorMsg = "Unauthorized. Please check your auth token.";
      }
      return { ok: false, error: errorMsg };
    }

    const data = response.json as RecallApiResponse;
    if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
      return { ok: false, error: "Unexpected response format from Worker." };
    }

    const results: NormalizedRecallResult[] = data.results
      .filter((item): item is RecallResult & { id: string; content: string } =>
        typeof item?.id === "string" && typeof item?.content === "string"
      )
      .map((item) => ({
        id: item.id,
        title: this.generateMemoryTitle(item.content, item.id),
        snippet: this.buildSnippet(item.content),
        content: item.content,
        tags: this.parseMemoryTags(item.tags),
        score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
        createdAt: this.formatExternalValue(item.created_at) || null,
      }));

    const insight = typeof data.insight === "string" && data.insight.trim() ? data.insight.trim() : null;

    return { ok: true, results, insight };
  }

  buildSnippet(content: string, maxChars = 220): string {
    const flat = content.replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars) return flat;
    return flat.slice(0, maxChars).trim() + "…";
  }

  formatExternalValue(value: unknown): string {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return "";
  }

  normalizeMarkdown(content: string): string {
    const isStructural = (line: string): boolean => {
      const trimmed = line.trim();
      return (
        /^#{1,6}\s/.test(trimmed) ||
        /^[-*+]\s/.test(trimmed) ||
        /^\d+[.)]\s/.test(trimmed) ||
        /^>/.test(trimmed) ||
        /^```/.test(trimmed)
      );
    };

    const rawLines = content.split("\n");
    const output: string[] = [];
    const outputInFence: boolean[] = []; // Track fence state for each output line
    let inFence = false;

    for (const rawLine of rawLines) {
      const trimmedRight = rawLine.replace(/[ \t]+$/, "");
      const trimmed = trimmedRight.trim();
      const isFenceMarker = /^```/.test(trimmed);

      if (isFenceMarker) {
        if (!inFence) {
          const prev = output.length > 0 ? output[output.length - 1] : null;
          if (prev !== null && prev.trim() !== "") {
            output.push("");
            outputInFence.push(false);
          }
        }
        output.push(trimmedRight);
        outputInFence.push(inFence); // Record state before toggle
        inFence = !inFence;
        continue;
      }

      if (inFence) {
        output.push(rawLine);
        outputInFence.push(true);
        continue;
      }

      let line = trimmedRight;
      if (/^\s*[*+]\s/.test(line)) {
        line = line.replace(/^(\s*)[*+](\s)/, "$1-$2");
      }

      const prev = output.length > 0 ? output[output.length - 1] : null;
      const prevTrimmed = prev?.trim() ?? "";
      const prevIsStructural = prev !== null && isStructural(prev);
      const lineIsStructural = isStructural(line);

      if (trimmed !== "" && prev !== null && prevTrimmed !== "" && lineIsStructural !== prevIsStructural) {
        output.push("");
        outputInFence.push(false);
      }

      output.push(line);
      outputInFence.push(false);
    }

    const collapsed: string[] = [];
    let i = 0;
    while (i < output.length) {
      if (output[i].trim() === "") {
        let j = i;
        while (j < output.length && output[j].trim() === "") j++;
        const runLength = j - i;
        // Only collapse if NO lines in the run are inside a fence
        const hasAnyInFence = outputInFence.slice(i, j).some((isFenced) => isFenced);
        if (runLength >= 3 && !hasAnyInFence) {
          collapsed.push("");
        } else {
          for (let k = i; k < j; k++) collapsed.push(output[k]);
        }
        i = j;
      } else {
        collapsed.push(output[i]);
        i++;
      }
    }

    return collapsed.join("\n").trim();
  }

  buildFrontmatter(lines: string[]): string {
    return `---\n${lines.join("\n")}\n---`;
  }

  async createAndOpenNote(folder: string, title: string, body: string): Promise<void> {
    const targetFolder = folder.trim() || this.settings.importFolder?.trim() || "_Second Brain/Inbox";
    await this.ensureFolderExists(targetFolder);

    const sanitizedTitle = this.sanitizeFileName(title);
    const path = this.getAvailableFilePath(targetFolder, sanitizedTitle);

    await this.app.vault.create(path, body);

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }

    new Notice(`Saved note: ${sanitizedTitle}`);
  }

  defaultSearchNoteTitle(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return `Search - ${new Date().toISOString().slice(0, 10)}`;
    return this.sanitizeFileName(trimmed);
  }

  defaultInsightNoteTitle(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return `Insight - ${new Date().toISOString().slice(0, 10)}`;
    return this.sanitizeFileName(`Insight - ${trimmed}`);
  }

  formatResultDateLabel(createdAt: string | null): string | null {
    if (!createdAt) return null;
    const match = createdAt.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : createdAt;
  }

  async saveSearchResultsAsNote(
    query: string,
    results: NormalizedRecallResult[],
    title: string,
    folder: string
  ): Promise<void> {
    const recalledAt = new Date().toISOString();
    const escapedQuery = query.replace(/"/g, '\\"');

    const frontmatter = this.buildFrontmatter([
      `query: "${escapedQuery}"`,
      `recalled_at: "${recalledAt}"`,
      `source: second-brain`,
    ]);

    const entries = results.map((result) => {
      const meta: string[] = [];
      if (result.score !== null) meta.push(`score: ${result.score.toFixed(1)}`);
      const dateLabel = this.formatResultDateLabel(result.createdAt);
      if (dateLabel) meta.push(dateLabel);
      const metaText = meta.length > 0 ? ` (${meta.join(" · ")})` : "";

      const normalizedContent = this.normalizeMarkdown(result.content);
      const indentedContent = normalizedContent
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : `  ${line}`))
        .join("\n");

      const tagsLine = result.tags.length > 0
        ? `\n  Tags: ${result.tags.map((t) => `#${t}`).join(" ")}`
        : "";

      return `- **${result.title}**${metaText}\n${indentedContent}${tagsLine}`;
    });

    const body = `${frontmatter}\n\n# ${title}\n\n${entries.join("\n\n")}\n`;
    await this.createAndOpenNote(folder, title, body);
  }

  async saveSingleResultAsNote(
    query: string,
    result: NormalizedRecallResult,
    title: string,
    folder: string
  ): Promise<void> {
    const recalledAt = new Date().toISOString();
    const escapedQuery = query.replace(/"/g, '\\"');

    const frontmatter = this.buildFrontmatter([
      `query: "${escapedQuery}"`,
      `recalled_at: "${recalledAt}"`,
      `source: second-brain`,
    ]);

    const normalizedContent = this.normalizeMarkdown(result.content);
    const body = `${frontmatter}\n\n# ${title}\n\nSource memory ID: ${result.id}\n\n${normalizedContent}\n`;
    await this.createAndOpenNote(folder, title, body);
  }

  async saveInsightAsNote(
    query: string,
    insight: string,
    title: string,
    folder: string
  ): Promise<void> {
    const recalledAt = new Date().toISOString();
    const escapedQuery = query.replace(/"/g, '\\"');

    const frontmatter = this.buildFrontmatter([
      `query: "${escapedQuery}"`,
      `recalled_at: "${recalledAt}"`,
      `source: second-brain`,
      `type: insight`,
    ]);

    const normalizedInsight = this.normalizeMarkdown(insight);
    const body = `${frontmatter}\n\n# ${title}\n\n${normalizedInsight}\n`;
    await this.createAndOpenNote(folder, title, body);
  }

  async loadSettings() {
    const stored = await this.loadData() as unknown as Partial<SecondBrainSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    if (!stored?.defaultDestination) this.settings.defaultDestination = { workspace: "personal" };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Search View ──────────────────────────────────────────────────────────────

class SearchView extends ItemView {
  plugin: SecondBrainPlugin;
  queryInput: HTMLInputElement;
  resultsEl: HTMLElement;
  expandedIds: Set<string> = new Set();
  isSearching = false;
  requestToken = 0;
  lastQuery = "";

  constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SEARCH;
  }

  getDisplayText(): string {
    return "Second brain search";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("second-brain-search-view");

    container.createEl("h4", { text: "Search second brain" });

    const searchRow = container.createDiv({ cls: "second-brain-search-row" });

    this.queryInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Ask your Second Brain anything…",
      cls: "second-brain-search-input",
    });

    this.queryInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void this.runSearch();
      }
    });

    const searchButton = searchRow.createEl("button", {
      text: "Search",
      cls: "second-brain-search-button",
    });
    searchButton.addEventListener("click", () => void this.runSearch());

    this.resultsEl = container.createDiv({ cls: "second-brain-search-results" });
  }

  async onClose() {
    this.contentEl.empty();
  }

  async runSearch() {
    if (this.isSearching) return;

    const query = this.queryInput.value;
    const token = ++this.requestToken;
    this.isSearching = true;
    this.lastQuery = query;
    this.renderLoading();

    try {
      const outcome = await this.plugin.recallMemories(query);
      if (token !== this.requestToken) return; // stale response — a newer search superseded this one

      this.expandedIds.clear();
      if (!outcome.ok) {
        this.renderError(outcome.error);
        return;
      }
      this.renderResults(outcome.results, outcome.insight);
    } finally {
      if (token === this.requestToken) {
        this.isSearching = false;
      }
    }
  }

  renderLoading() {
    this.resultsEl.empty();
    this.resultsEl.createEl("p", { text: "Searching…", cls: "second-brain-search-status" });
  }

  renderError(message: string) {
    this.resultsEl.empty();
    this.resultsEl.createEl("p", {
      text: message,
      cls: "second-brain-search-status second-brain-search-error",
    });
  }

  defaultSaveFolder(): string {
    return this.plugin.settings.importFolder?.trim() || "_Second Brain/Inbox";
  }

  renderResults(results: NormalizedRecallResult[], insight: string | null) {
    this.resultsEl.empty();

    if (insight) {
      const insightEl = this.resultsEl.createDiv({ cls: "second-brain-search-insight" });

      const insightText = insightEl.createDiv({ cls: "second-brain-search-insight-text" });
      insightText.setText(insight);

      const saveInsightButton = insightEl.createEl("button", {
        cls: "second-brain-save-icon-button",
        attr: { "aria-label": "Save insight as note" },
      });
      setIcon(saveInsightButton, "file-plus");
      saveInsightButton.addEventListener("click", () => {
        new SaveNoteModal(
          this.app,
          this.plugin.defaultInsightNoteTitle(this.lastQuery),
          this.defaultSaveFolder(),
          (title, folder) => this.plugin.saveInsightAsNote(this.lastQuery, insight, title, folder)
        ).open();
      });
    }

    if (results.length === 0) {
      this.resultsEl.createEl("p", {
        text: "No memories found for that search.",
        cls: "second-brain-search-status",
      });
      return;
    }

    const saveAllRow = this.resultsEl.createDiv({ cls: "second-brain-search-save-all-row" });
    const saveAllButton = saveAllRow.createEl("button", { text: "Save all as note" });
    saveAllButton.addEventListener("click", () => {
      new SaveNoteModal(
        this.app,
        this.plugin.defaultSearchNoteTitle(this.lastQuery),
        this.defaultSaveFolder(),
        (title, folder) => this.plugin.saveSearchResultsAsNote(this.lastQuery, results, title, folder)
      ).open();
    });

    const list = this.resultsEl.createEl("ul", { cls: "second-brain-search-list" });

    for (const result of results) {
      this.renderResultItem(list, result);
    }
  }

  renderResultItem(list: HTMLElement, result: NormalizedRecallResult) {
    const item = list.createEl("li", { cls: "second-brain-search-item" });

    item.addEventListener("click", () => {
      if (this.expandedIds.has(result.id)) {
        this.expandedIds.delete(result.id);
      } else {
        this.expandedIds.add(result.id);
      }
      item.empty();
      this.renderResultItemContent(item, result);
    });

    this.renderResultItemContent(item, result);
  }

  renderResultItemContent(item: HTMLElement, result: NormalizedRecallResult) {
    const isExpanded = this.expandedIds.has(result.id);

    const titleRow = item.createDiv({ cls: "second-brain-search-item-title" });

    const titleSpan = titleRow.createSpan();
    titleSpan.setText(`${isExpanded ? "▾ " : "▸ "}${result.title}`);

    if (result.score !== null) {
      titleRow.createSpan({
        text: result.score.toFixed(1),
        cls: "second-brain-search-item-score",
      });
    }

    const saveResultButton = titleRow.createEl("button", {
      cls: "second-brain-save-icon-button",
      attr: { "aria-label": "Save memory as note" },
    });
    setIcon(saveResultButton, "file-plus");
    saveResultButton.addEventListener("click", (evt) => {
      evt.stopPropagation();
      new SaveNoteModal(
        this.app,
        result.title,
        this.defaultSaveFolder(),
        (title, folder) => this.plugin.saveSingleResultAsNote(this.lastQuery, result, title, folder)
      ).open();
    });

    const bodyText = isExpanded ? result.content.replace(/\s+/g, " ").trim() : result.snippet;
    item.createEl("p", {
      text: bodyText,
      cls: isExpanded ? "second-brain-search-item-content" : "second-brain-search-item-snippet",
    });

    if (result.tags.length > 0) {
      const tagsEl = item.createDiv({ cls: "second-brain-search-item-tags" });
      for (const tag of result.tags) {
        tagsEl.createSpan({ text: `#${tag}` });
      }
    }
  }
}

class DestinationModal extends Modal {
  plugin: SecondBrainPlugin;
  file: TFile;
  selected: Destination;
  teams: TeamSummary[] = [];
  loading = true;
  error = "";
  saveButton: HTMLButtonElement | null = null;

  constructor(app: App, plugin: SecondBrainPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const parsed = parseDestinationProperties(
      frontmatter["second-brain-workspace"],
      frontmatter["second-brain-team"],
      frontmatter["second-brain-team-name"],
    );
    this.selected = parsed.kind === "valid" ? parsed.destination : this.plugin.settings.defaultDestination;
    if (this.selected.workspace === "company" && !this.selected.teamId) {
      this.selected = { workspace: "personal" };
    }
  }

  onOpen() {
    this.render();
    void this.loadTeamsForPicker();
  }

  async loadTeamsForPicker() {
    try {
      this.teams = await this.plugin.loadTeams();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Team lookup failed. Retry.";
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Memory destination" });
    contentEl.createEl("p", {
      text: "Choose where this note's future syncs are stored. Existing tracked memories will move there on the next sync.",
      cls: "setting-item-description",
    });
    if (this.error) {
      contentEl.createEl("p", { text: this.error, cls: "second-brain-destination-error" });
    }

    const destinationSetting = new Setting(contentEl)
      .setName("Destination")
      .setDesc(this.loading ? "Loading named teams…" : "Team names come from your current Worker membership.");
    destinationSetting.addDropdown((dropdown) => {
      dropdown.addOption("personal", "Personal");
      for (const team of this.teams) dropdown.addOption(team.id, team.name);
      const selectedValue = this.selected.workspace === "company" ? this.selected.teamId : "personal";
      if (selectedValue && (selectedValue === "personal" || this.teams.some((team) => team.id === selectedValue))) {
        dropdown.setValue(selectedValue);
      } else {
        dropdown.setValue("personal");
      }
      dropdown.onChange((value) => {
        this.selected = value === "personal"
          ? { workspace: "personal" }
          : { workspace: "company", teamId: value };
      });
    });

    const buttonRow = contentEl.createDiv({ cls: "second-brain-destination-buttons" });
    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
    this.saveButton = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.saveSelection());
  }

  async saveSelection() {
    if (this.selected.workspace === "company" &&
      (!this.selected.teamId || !this.teams.some((team) => team.id === this.selected.teamId))) {
      new Notice("Choose a current named team before saving.");
      return;
    }
    if (this.saveButton) this.saveButton.disabled = true;
    try {
      await this.plugin.setNoteDestination(this.file, this.selected);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the memory destination.");
      if (this.saveButton) this.saveButton.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Save Note Modal ──────────────────────────────────────────────────────────

class SaveNoteModal extends Modal {
  titleValue: string;
  folderValue: string;
  onSave: (title: string, folder: string) => Promise<void>;

  constructor(
    app: App,
    defaultTitle: string,
    defaultFolder: string,
    onSave: (title: string, folder: string) => Promise<void>
  ) {
    super(app);
    this.titleValue = defaultTitle;
    this.folderValue = defaultFolder;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Save as note" });

    new Setting(contentEl)
      .setName("Title")
      .addText((text) =>
        text.setValue(this.titleValue).onChange((value) => {
          this.titleValue = value;
        })
      );

    new Setting(contentEl)
      .setName("Folder")
      .addText((text) =>
        text.setValue(this.folderValue).onChange((value) => {
          this.folderValue = value;
        })
      );

    const buttonRow = contentEl.createDiv({ cls: "second-brain-save-note-buttons" });

    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    const saveButton = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveButton.addEventListener("click", () => void this.handleSave(saveButton));
  }

  async handleSave(saveButton: HTMLButtonElement) {
    if (!this.titleValue.trim()) {
      new Notice("Title cannot be empty.");
      return;
    }
    saveButton.disabled = true;
    try {
      await this.onSave(this.titleValue, this.folderValue);
      this.close();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save note.";
      new Notice(message);
      saveButton.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class SecondBrainSettingTab extends PluginSettingTab {
  plugin: SecondBrainPlugin;

  constructor(app: App, plugin: SecondBrainPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return [];
  }

  display(): void {
    this.render();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Second brain").setHeading();

    // ── Connection ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Your Cloudflare Worker URL — e.g. https://second-brain.yourname.workers.dev")
      .addText((text) =>
        text
          .setPlaceholder("https://second-brain.yourname.workers.dev")
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (value) => {
            this.plugin.settings.workerUrl = value.trim().replace(/\/$/, "");
            this.plugin.settingsGeneration++;
            this.plugin.invalidateTeamCache();
            await this.plugin.saveSettings();
            this.render();
          })
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Your worker auth token. Keep this private.")
      .addText((text) => {
        text
          .setPlaceholder("Paste your token here")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            this.plugin.settingsGeneration++;
            this.plugin.invalidateTeamCache();
            await this.plugin.saveSettings();
            this.render();
          });
        text.inputEl.type = "password";
        return text;
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify your worker URL and token are correct")
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .onClick(async () => {
            if (!this.plugin.validateSettings()) return;
            try {
              const response = await requestUrl({
                url: `${this.plugin.settings.workerUrl}/list?n=1`,
                headers: { Authorization: `Bearer ${this.plugin.settings.authToken}` },
                throw: false,
              });
              if (response.status === 200) {
                new Notice("Second brain: connected successfully");
              } else if (response.status === 401) {
                new Notice("Second brain: auth token is wrong");
              } else {
                new Notice(`Second brain: unexpected status ${response.status}`);
              }
            } catch {
              new Notice("Second brain: could not reach worker — check the URL");
            }
          })
      );

    // ── Sync behaviour ──────────────────────────────────────────────────────
    new Setting(containerEl).setName("Sync behaviour").setHeading();

    const defaultDestination = this.plugin.settings.defaultDestination;
    const defaultTeams = this.plugin.teamCacheKey === this.plugin.connectionKey()
      ? (this.plugin.teamCache ?? [])
      : [];
    new Setting(containerEl)
      .setName("Default memory destination")
      .setDesc("Applies only to notes that have not synced before. Existing notes keep their pinned destination.")
      .addDropdown((dropdown) => {
        dropdown.addOption("personal", "Personal");
        for (const team of defaultTeams) dropdown.addOption(team.id, team.name);
        const configured = defaultDestination.workspace === "company" ? defaultDestination.teamId : "personal";
        if (configured && (configured === "personal" || defaultTeams.some((team) => team.id === configured))) {
          dropdown.setValue(configured);
        } else {
          dropdown.setValue("personal");
        }
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultDestination = value === "personal"
            ? { workspace: "personal" }
            : { workspace: "company", teamId: value, teamName: defaultTeams.find((team) => team.id === value)?.name };
          this.plugin.settingsGeneration++;
          await this.plugin.saveSettings();
          this.render();
        });
      });

    if (this.plugin.settings.workerUrl && this.plugin.settings.authToken &&
      this.plugin.teamCacheKey !== this.plugin.connectionKey() && !this.plugin.teamLoadPromise) {
      void this.plugin.loadTeams().then(() => this.render()).catch(() => undefined);
    }

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Sync all notes in your vault, or only notes with a specific tag.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("tagged", "Tagged notes only")
          .addOption("all", "All notes")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as SyncMode;
            await this.plugin.saveSettings();
            this.render();
          });
      });

    if (this.plugin.settings.syncMode === "tagged") {
      new Setting(containerEl)
        .setName("Sync tag")
        .setDesc("Only notes with this tag in their frontmatter will be synced. Default: brain")
        .addText((text) =>
          text
            .setPlaceholder("Brain")
            .setValue(this.plugin.settings.syncTag)
            .onChange(async (value) => {
              this.plugin.settings.syncTag = value.trim() || "brain";
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Auto-sync on save")
      .setDesc(this.plugin.settings.syncMode === "all"
        ? "Automatically sync every note when you save it."
        : "Automatically sync tagged notes when you save them.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            this.render();
          })
      );

    if (this.plugin.settings.autoSync) {
      new Setting(containerEl)
        .setName("Auto-sync delay (seconds)")
        .setDesc("Wait this long after you stop typing before syncing. Default: 5 seconds")
        .addSlider((slider) =>
          slider
            .setLimits(3, 30, 1)
            .setValue(this.plugin.settings.autoSyncDelay / 1000)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.autoSyncDelay = value * 1000;
              await this.plugin.saveSettings();
            })
        );
    }

    // ── Chunking ────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Chunking")
      .setDesc("Long notes are split into overlapping segments so each part gets a clean embedding. Short notes are stored as-is.")
      .setHeading();

    new Setting(containerEl)
      .setName("Chunk size (characters)")
      .setDesc("Maximum characters per chunk. Default: 1600 (~400 tokens)")
      .addSlider((slider) =>
        slider
          .setLimits(400, 4000, 100)
          .setValue(this.plugin.settings.chunkSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chunk overlap (characters)")
      .setDesc("Overlap between chunks to preserve context at boundaries. Default: 200")
      .addSlider((slider) =>
        slider
          .setLimits(0, 500, 50)
          .setValue(this.plugin.settings.chunkOverlap)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.chunkOverlap = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Import behavior ─────────────────────────────────────────────────────
    new Setting(containerEl).setName("Import behavior").setHeading();

    new Setting(containerEl)
      .setName("Import folder")
      .setDesc("Folder where imported memories will be saved.")
      .addText((text) =>
        text
          .setPlaceholder("_second brain/inbox")
          .setValue(this.plugin.settings.importFolder)
          .onChange(async (value) => {
            this.plugin.settings.importFolder = value.trim() || "_Second Brain/Inbox";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Import tag")
      .setDesc("Tag used to filter external memories to import.")
      .addText((text) =>
        text
          .setPlaceholder("Obsidian-inbox")
          .setValue(this.plugin.settings.importTag)
          .onChange(async (value) => {
            this.plugin.settings.importTag = value.trim() || "obsidian-inbox";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Import limit")
      .setDesc("Maximum number of memories to fetch per import.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.importLimit))
          .onChange(async (value) => {
            const parsed = parseInt(value.trim(), 10);
            if (isNaN(parsed) || parsed < 1) {
              new Notice("Import limit must be a positive number");
              text.setValue(String(this.plugin.settings.importLimit));
              return;
            }
            this.plugin.settings.importLimit = parsed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pull/import on startup")
      .setDesc("Automatically pull memories from your second brain when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pullOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.pullOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Reset imported ids cache")
      .setDesc(`Clear the list of previously imported memory IDs. Currently contains ${this.plugin.settings.importedIds?.length ?? 0} ID(s).`)
      .addButton((btn) =>
        btn
          .setButtonText("Reset cache")
          .onClick(async () => {
            this.plugin.settings.importedIds = [];
            await this.plugin.saveSettings();
            this.render();
            new Notice("Imported ids cache has been reset");
          })
      );

    // ── Display ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Display").setHeading();

    new Setting(containerEl)
      .setName("Show sync status in status bar")
      .setDesc("Shows the last sync time in the Obsidian status bar")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSyncStatus)
          .onChange(async (value) => {
            this.plugin.settings.showSyncStatus = value;
            await this.plugin.saveSettings();
            // FIX: manage status bar element lifecycle when toggled
            if (value && !this.plugin.statusBar) {
              this.plugin.statusBar = this.plugin.addStatusBarItem();
              this.plugin.updateStatusBar();
            } else if (!value && this.plugin.statusBar) {
              this.plugin.statusBar.remove();
              this.plugin.statusBar = null;
            }
          })
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Actions").setHeading();

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(this.plugin.settings.syncMode === "all"
        ? "Sync all notes in your vault to your Second Brain"
        : `Sync all notes tagged with "${this.plugin.settings.syncTag}" to your Second Brain`)
      .addButton((btn) =>
        btn
          .setButtonText("Sync all")
          .setCta()
          .onClick(() => this.plugin.syncAllTagged())
      );

    if (this.plugin.settings.lastSyncTime) {
      const date = new Date(this.plugin.settings.lastSyncTime);
      containerEl.createEl("p", {
        text: `Last synced: ${date.toLocaleString()}`,
        cls: "setting-item-description",
      });
    }
  }
}
