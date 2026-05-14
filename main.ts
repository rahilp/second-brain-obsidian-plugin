import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  ItemView,
  WorkspaceLeaf,
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
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: true,
  lastSyncTime: null,
};

// ─── Sidebar view ─────────────────────────────────────────────────────────────

const SIDEBAR_VIEW_TYPE = "second-brain-search";

class SecondBrainSidebarView extends ItemView {
  plugin: SecondBrainPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return SIDEBAR_VIEW_TYPE; }
  getDisplayText() { return "Second Brain"; }
  getIcon() { return "brain"; }

  async onOpen() { this.render(); }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("second-brain-sidebar");

    container.createEl("h4", { text: "Second Brain Search" });

    const searchRow = container.createDiv("second-brain-search-row");
    const input = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search your brain...",
      cls: "second-brain-input",
    });

    const btn = searchRow.createEl("button", {
      text: "Search",
      cls: "second-brain-btn",
    });

    const results = container.createDiv("second-brain-results");

    const doSearch = async () => {
      const query = input.value.trim();
      if (!query) return;

      results.empty();
      results.createEl("p", { text: "Searching...", cls: "second-brain-searching" });

      try {
        const response = await requestUrl({
          url: `${this.plugin.settings.workerUrl}/search?q=${encodeURIComponent(query)}`,
          headers: { Authorization: `Bearer ${this.plugin.settings.authToken}` },
        });

        results.empty();

        if (!response.json?.results?.length) {
          results.createEl("p", { text: "Nothing found.", cls: "second-brain-empty" });
          return;
        }

        for (const item of response.json.results) {
          const card = results.createDiv("second-brain-card");
          card.createEl("p", { text: item.content.slice(0, 200) + (item.content.length > 200 ? "..." : "") });
          const meta = card.createDiv("second-brain-meta");
          meta.createEl("span", { text: item.date });
          meta.createEl("span", { text: item.source });
          if (item.score) meta.createEl("span", { text: `${item.score}% match` });
        }
      } catch (e) {
        results.empty();
        results.createEl("p", { text: "Search failed. Check your Worker URL and token.", cls: "second-brain-error" });
      }
    };

    btn.addEventListener("click", doSearch);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }
}

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

  async onload() {
    await this.loadSettings();

    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }

    // FIX 1: register view but do NOT detach in onunload
    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new SecondBrainSidebarView(leaf, this));

    this.addRibbonIcon("brain", "Sync current note to Second Brain", () => {
      this.syncActiveNote();
    });

    this.addRibbonIcon("search", "Search Second Brain", () => {
      this.activateSidebar();
    });

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note to Second Brain",
      editorCallback: (_editor: Editor, view: MarkdownView) => {
        this.syncFile(view.file!);
      },
    });

    this.addCommand({
      id: "sync-all-tagged",
      name: "Sync all notes to Second Brain",
      callback: () => this.syncAllTagged(),
    });

    this.addCommand({
      id: "open-search",
      name: "Open Second Brain search",
      callback: () => this.activateSidebar(),
    });

    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", async (file) => {
          if (file instanceof TFile && file.extension === "md") {
            await this.syncIfTagged(file);
          }
        })
      );
    }

    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
  }

  // FIX 1: removed onunload that called detachLeavesOfType
  // Obsidian handles leaf lifecycle automatically

  // ── Sync methods ────────────────────────────────────────────────────────────

  async syncActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note open"); return; }
    await this.syncFile(file);
  }

  async syncIfTagged(file: TFile) {
    if (this.settings.syncMode === "all") {
      await this.syncFile(file);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const tags: string[] = cache?.frontmatter?.tags ?? [];
    if (!tags.includes(this.settings.syncTag)) return;
    await this.syncFile(file);
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
      await new Promise((r) => setTimeout(r, 300));
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    this.updateStatusBar();

    new Notice(`Second Brain: ${synced} synced${failed ? `, ${failed} failed` : ""}`);
  }

  async syncFile(file: TFile, silent = false): Promise<boolean> {
    if (!this.validateSettings()) return false;

    const raw = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ?? {};

    const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
    const title = file.basename;
    const noteTags: string[] = frontmatter.tags ?? [];

    const fullContent = `${title}\n\n${body}`;
    const chunks = chunkText(fullContent, this.settings.chunkSize, this.settings.chunkOverlap);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload: Record<string, unknown> = {
          content: chunks.length > 1 ? `${chunks[i]} [chunk ${i + 1}/${chunks.length}]` : chunks[i],
          source: "obsidian",
          tags: [...noteTags, "obsidian", file.parent?.name ?? ""].filter(Boolean),
        };

        const response = await requestUrl({
          url: `${this.settings.workerUrl}/capture`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          throw: false,
        });

        if (response.status !== 200) {
          if (!silent) new Notice(`Second Brain error: ${response.json?.error ?? response.status}`);
          return false;
        }

        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 200));
      }

      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this.updateStatusBar();

      if (!silent) {
        const chunkNote = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
        new Notice(`✓ Saved "${title}" to Second Brain${chunkNote}`);
      }

      return true;
    } catch (e) {
      if (!silent) new Notice("Second Brain: failed to connect to Worker");
      console.error("Second Brain sync error:", e);
      return false;
    }
  }

  // ── Sidebar ─────────────────────────────────────────────────────────────────

  async activateSidebar() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];

    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
    }

    // FIX 2: revealLeaf is fine since minAppVersion is now 1.7.2 in manifest
    workspace.revealLeaf(leaf);
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

    // FIX 3: use Setting.setHeading() for all section headers instead of createEl("h2/h3")
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
          })
      );

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
