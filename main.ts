import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  requestUrl,
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class SecondBrainPlugin extends Plugin {
  settings: SecondBrainSettings;
  statusBar: HTMLElement | null = null;
  // number (browser) rather than NodeJS.Timeout — we use activeWindow.setTimeout
  debounceTimers: Map<string, number> = new Map();
  syncingFiles: Set<string> = new Set();

  async onload() {
    await this.loadSettings();

    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }

    this.addRibbonIcon("brain", "Sync current note to Second Brain", () => {
      this.syncActiveNote();
    });

    // FIX: command names must not include the plugin name (rule 15)
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      editorCallback: (_editor: Editor, view: MarkdownView) => {
        this.syncFile(view.file!);
      },
    });

    this.addCommand({
      id: "sync-all-tagged",
      name: "Sync all tagged notes",
      callback: () => this.syncAllTagged(),
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

    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
  }

  // FIX: removed onunload that called detachLeavesOfType — Obsidian handles
  // leaf lifecycle automatically, and registerEvent handles event cleanup.

  // ── Sync methods ────────────────────────────────────────────────────────────

  async syncActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note open"); return; }
    await this.syncFile(file);
  }

  async debouncedSyncIfTagged(file: TFile) {
    if (this.syncingFiles.has(file.path)) return;

    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) clearTimeout(existingTimer);

    // FIX: use activeWindow.setTimeout for popout window compatibility (rule 30)
    const timer = activeWindow.setTimeout(async () => {
      this.debounceTimers.delete(file.path);
      await this.syncIfTagged(file);
    }, this.settings.autoSyncDelay);

    this.debounceTimers.set(file.path, timer);
  }

  async syncIfTagged(file: TFile, silent = false) {
    if (this.settings.syncMode === "all") {
      await this.syncFile(file, silent);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatterTags: string[] = cache?.frontmatter?.tags ?? [];
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
          const tags: string[] = cache?.frontmatter?.tags ?? [];
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
      // FIX: activeWindow.setTimeout for popout window compatibility (rule 30)
      await new Promise((r) => activeWindow.setTimeout(r, 300));
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
      const noteTags: string[] = frontmatter.tags ?? [];

      // FIX: normalize stored IDs — support legacy single string and new array format.
      // This lets us track all chunk IDs so every chunk is updated on re-sync.
      const rawStoredId = frontmatter["second-brain-id"];
      const existingIds: string[] = Array.isArray(rawStoredId)
        ? rawStoredId
        : rawStoredId ? [rawStoredId as string] : [];

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

          if (response.status !== 200 || !response.json?.ok) {
            if (!silent) {
              const errorMsg = response.json?.error ?? `Server returned ${response.status}`;
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

          if (response.status !== 200) {
            if (!silent) {
              const errorMsg = response.json?.error ?? `Server returned ${response.status}`;
              new Notice(`Second Brain error: ${errorMsg}`);
            }
            return false;
          }

          if (response.json?.id) newIds.push(response.json.id);
        }

        if (i < chunks.length - 1) {
          // FIX: activeWindow.setTimeout for popout window compatibility (rule 30)
          await new Promise((r) => activeWindow.setTimeout(r, 200));
        }
      }

      // Persist IDs for all active chunks. If the note shrank and has fewer chunks
      // than before, the extra old IDs are no longer tracked (those entries remain
      // in Second Brain but won't receive further updates). They can be cleaned up
      // manually via the Second Brain web UI or the forget MCP tool.
      if (newIds.length > 0) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
            } catch (e) {
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
            this.display();
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
            this.display();
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
