import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  RequestUrlResponse,
  TFile,
  WorkspaceLeaf,
  requestUrl,
  normalizePath,
} from "obsidian";

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
};

// ─── Chunking ─────────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      const lastPeriod  = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint  = Math.max(lastPeriod, lastNewline);
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
}

const VIEW_TYPE_SEARCH = "second-brain-search";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class SecondBrainPlugin extends Plugin {
  settings: SecondBrainSettings;
  statusBar: HTMLElement | null = null;
  // number (browser) rather than NodeJS.Timeout — we use window.setTimeout
  debounceTimers: Map<string, number> = new Map();
  syncingFiles: Set<string> = new Set();
  isImporting = false;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_SEARCH, (leaf) => new SearchView(leaf, this));

    this.addRibbonIcon("search", "Search Second Brain memories", () => {
      void this.activateSearchView();
    });

    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }

    this.addRibbonIcon("brain", "Sync current note to Second Brain", () => {
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

    // FIX: always register modify event; gate on this.settings.autoSync inside the
    // handler so toggling auto-sync in settings takes effect immediately without
    // requiring an Obsidian restart.
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!this.settings.autoSync) return;
        if (file instanceof TFile && file.extension === "md") {
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

  // No onunload override: Obsidian manages leaf lifecycle automatically.
  // Forcibly detaching leaves on unload resets user-defined leaf positions
  // and was previously flagged by the Obsidian plugin review process
  // (see commit 57a804e).

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
    const frontmatterTags: string[] = (cache?.frontmatter?.tags as string[] | undefined) ?? [];
    // cache.tags includes inline tags (#brain in body); strip the leading #
    const inlineTags: string[] = (cache?.tags ?? []).map((t) => t.tag.replace(/^#/, ""));
    const allTags = [...frontmatterTags, ...inlineTags];
    if (!allTags.includes(this.settings.syncTag)) return;
    await this.syncFile(file, silent);
  }

  async syncAllTagged() {
    if (!this.validateSettings()) return;

    const files = this.app.vault.getMarkdownFiles();
    const tagged = this.settings.syncMode === "all"
      ? files
      : files.filter((f) => {
          const cache = this.app.metadataCache.getFileCache(f);
          const tags: string[] = (cache?.frontmatter?.tags as string[] | undefined) ?? [];
          return tags.includes(this.settings.syncTag);
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

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    this.updateStatusBar();

    new Notice(`Second Brain: ${synced} synced${failed ? `, ${failed} failed` : ""}`);
  }

  async syncFile(file: TFile, silent = false): Promise<boolean> {
    if (!this.validateSettings()) return false;

    if (this.syncingFiles.has(file.path)) return true;
    this.syncingFiles.add(file.path);

    try {
      const raw = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter ?? {};

      const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
      const title = file.basename;
      const noteTags: string[] = (frontmatter.tags as string[] | undefined) ?? [];

      // Normalize stored IDs — support legacy single string and new array format.
      const rawStoredId = frontmatter["second-brain-id"] as string | string[] | undefined;
      const existingIds: string[] = Array.isArray(rawStoredId)
        ? rawStoredId
        : rawStoredId ? [rawStoredId] : [];

      const fullContent = `${title}\n\n${body}`;
      const chunks = chunkText(fullContent, this.settings.chunkSize, this.settings.chunkOverlap);
      const capturedTags = [...new Set([...noteTags, "obsidian", file.parent?.name ?? ""].filter(Boolean))];

      const newIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkContent = chunks.length > 1
          ? `${chunks[i]} [chunk ${i + 1}/${chunks.length}]`
          : chunks[i];

        if (i < existingIds.length) {
          // FIX: use /update (full replace + re-embed) instead of /append.
          // /append treats the content as an addendum and accumulates it —
          // re-syncing a note would keep appending the full content on each save.
          // /update replaces the entry content and re-embeds cleanly.
          const response = await requestUrl({
            url: `${this.settings.workerUrl}/update`,
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.settings.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: existingIds[i], content: chunkContent }),
            throw: false,
          });

          const updateJson = response.json as ApiResponse;
          if (response.status !== 200 || !updateJson?.ok) {
            if (!silent) {
              const errorMsg = updateJson?.error ?? `Server returned ${response.status}`;
              new Notice(`Second Brain error: ${errorMsg}`);
            }
            return false;
          }

          newIds.push(existingIds[i]);
        } else {
          // Capture new chunk — either first-time sync or note grew since last sync
          const response = await requestUrl({
            url: `${this.settings.workerUrl}/capture`,
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.settings.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: chunkContent,
              source: "obsidian",
              tags: capturedTags,
            }),
            throw: false,
          });

          const captureJson = response.json as ApiResponse;
          if (response.status !== 200) {
            if (!silent) {
              const errorMsg = captureJson?.error ?? `Server returned ${response.status}`;
              new Notice(`Second Brain error: ${errorMsg}`);
            }
            return false;
          }

          if (captureJson?.id) newIds.push(captureJson.id);
        }

        if (i < chunks.length - 1) {
          await new Promise((r) => window.setTimeout(r, 200));
        }
      }

      // Persist IDs for all active chunks. If the note shrank and has fewer chunks
      // than before, the extra old IDs are no longer tracked (those entries remain
      // in Second Brain but won't receive further updates). They can be cleaned up
      // manually via the Second Brain web UI or the forget MCP tool.
      if (newIds.length > 0) {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          fm["second-brain-id"] = newIds.length === 1 ? newIds[0] : newIds;
          const now = new Date();
          const date = now.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
          const time = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
          fm["second-brain-synced"] = `${date} - ${time}`;
        });
      }

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
      if (!silent) new Notice("Second Brain: failed to connect to Worker");
      console.error("Second Brain sync error:", e);
      return false;
    } finally {
      this.syncingFiles.delete(file.path);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  validateSettings(): boolean {
    if (!this.settings.workerUrl) {
      new Notice("Second Brain: Worker URL not set. Go to Settings to configure.");
      return false;
    }
    if (!this.settings.authToken) {
      new Notice("Second Brain: Auth token not set. Go to Settings to configure.");
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
    if (!silent) new Notice("Starting import from Second Brain...");

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
          const createdAt = item.created_at != null ? String(item.created_at).replace(/"/g, '\\"') : "";
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
      if (!silent) new Notice("Second Brain import failed: check console logs for details.");
    } finally {
      this.isImporting = false;
    }
  }

  // ── Search / recall ─────────────────────────────────────────────────────────

  async recallMemories(query: string, topK = 10): Promise<
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
      }));

    const insight = typeof data.insight === "string" && data.insight.trim() ? data.insight.trim() : null;

    return { ok: true, results, insight };
  }

  buildSnippet(content: string, maxChars = 220): string {
    const flat = content.replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars) return flat;
    return flat.slice(0, maxChars).trim() + "…";
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as unknown as Partial<SecondBrainSettings>);
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

  constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SEARCH;
  }

  getDisplayText(): string {
    return "Second Brain search";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("second-brain-search-view");

    container.createEl("h4", { text: "Search Second Brain" });

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

    const buttonRow = container.createDiv({ cls: "second-brain-search-buttons" });

    const searchButton = buttonRow.createEl("button", { text: "Search" });
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

  renderResults(results: NormalizedRecallResult[], insight: string | null) {
    this.resultsEl.empty();

    if (insight) {
      const insightEl = this.resultsEl.createDiv({ cls: "second-brain-search-insight" });
      insightEl.setText(insight);
    }

    if (results.length === 0) {
      this.resultsEl.createEl("p", {
        text: "No memories found for that search.",
        cls: "second-brain-search-status",
      });
      return;
    }

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

    const bodyText = isExpanded ? result.content.replace(/\s+/g, " ").trim() : result.snippet;
    item.createEl("p", {
      text: bodyText,
      cls: isExpanded ? "second-brain-search-item-content" : "second-brain-search-item-snippet",
    });

    if (result.tags.length > 0) {
      const tagsEl = item.createDiv({ cls: "second-brain-search-item-tags" });
      tagsEl.setText(result.tags.map((t) => `#${t}`).join("  "));
    }
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class SecondBrainSettingTab extends PluginSettingTab {
  plugin: SecondBrainPlugin;

  constructor(app: App, plugin: SecondBrainPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.render();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Second Brain").setHeading();

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
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Your AUTH_TOKEN Worker secret. Keep this private.")
      .addText((text) => {
        text
          .setPlaceholder("paste your token here")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        return text;
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify your Worker URL and token are correct")
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
                new Notice("Second Brain: connected successfully");
              } else if (response.status === 401) {
                new Notice("Second Brain: auth token is wrong");
              } else {
                new Notice(`Second Brain: unexpected status ${response.status}`);
              }
            } catch {
              new Notice("Second Brain: could not reach Worker — check the URL");
            }
          })
      );

    // ── Sync behaviour ──────────────────────────────────────────────────────
    new Setting(containerEl).setName("Sync behaviour").setHeading();

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
            .setPlaceholder("brain")
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
          .setPlaceholder("_Second Brain/Inbox")
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
          .setPlaceholder("obsidian-inbox")
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
      .setDesc("Automatically pull memories from your Second Brain when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pullOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.pullOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Reset imported IDs cache")
      .setDesc(`Clear the list of previously imported memory IDs. Currently contains ${this.plugin.settings.importedIds?.length ?? 0} ID(s).`)
      .addButton((btn) =>
        btn
          .setButtonText("Reset cache")
          .onClick(async () => {
            this.plugin.settings.importedIds = [];
            await this.plugin.saveSettings();
            this.render();
            new Notice("Imported IDs cache has been reset");
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
