var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SecondBrainPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  workerUrl: "",
  authToken: "",
  syncMode: "tagged",
  syncTag: "brain",
  autoSync: false,
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: true,
  lastSyncTime: null
};
var SIDEBAR_VIEW_TYPE = "second-brain-search";
var SecondBrainSidebarView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return SIDEBAR_VIEW_TYPE;
  }
  getDisplayText() {
    return "Second Brain";
  }
  getIcon() {
    return "brain";
  }
  async onOpen() {
    this.render();
  }
  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("second-brain-sidebar");
    container.createEl("h4", { text: "Second Brain Search" });
    const searchRow = container.createDiv("second-brain-search-row");
    const input = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search your brain...",
      cls: "second-brain-input"
    });
    const btn = searchRow.createEl("button", {
      text: "Search",
      cls: "second-brain-btn"
    });
    const results = container.createDiv("second-brain-results");
    const doSearch = async () => {
      var _a, _b;
      const query = input.value.trim();
      if (!query)
        return;
      results.empty();
      results.createEl("p", { text: "Searching...", cls: "second-brain-searching" });
      try {
        const response = await (0, import_obsidian.requestUrl)({
          url: `${this.plugin.settings.workerUrl}/search?q=${encodeURIComponent(query)}`,
          headers: { Authorization: `Bearer ${this.plugin.settings.authToken}` }
        });
        results.empty();
        if (!((_b = (_a = response.json) == null ? void 0 : _a.results) == null ? void 0 : _b.length)) {
          results.createEl("p", { text: "Nothing found.", cls: "second-brain-empty" });
          return;
        }
        for (const item of response.json.results) {
          const card = results.createDiv("second-brain-card");
          card.createEl("p", { text: item.content.slice(0, 200) + (item.content.length > 200 ? "..." : "") });
          const meta = card.createDiv("second-brain-meta");
          meta.createEl("span", { text: item.date });
          meta.createEl("span", { text: item.source });
          if (item.score)
            meta.createEl("span", { text: `${item.score}% match` });
        }
      } catch (e) {
        results.empty();
        results.createEl("p", { text: "Search failed. Check your Worker URL and token.", cls: "second-brain-error" });
      }
    };
    btn.addEventListener("click", doSearch);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter")
        doSearch();
    });
  }
};
function chunkText(text, maxChars, overlapChars) {
  if (text.length <= maxChars)
    return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2)
        end = breakPoint + 1;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
    if (start >= text.length)
      break;
  }
  return chunks.filter((c) => c.length > 0);
}
var SecondBrainPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.statusBar = null;
  }
  async onload() {
    await this.loadSettings();
    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }
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
      editorCallback: (_editor, view) => {
        this.syncFile(view.file);
      }
    });
    this.addCommand({
      id: "sync-all-tagged",
      name: "Sync all tagged notes to Second Brain",
      callback: () => this.syncAllTagged()
    });
    this.addCommand({
      id: "open-search",
      name: "Open Second Brain search",
      callback: () => this.activateSidebar()
    });
    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", async (file) => {
          if (file instanceof import_obsidian.TFile && file.extension === "md") {
            await this.syncIfTagged(file);
          }
        })
      );
    }
    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
  }
  // ── Sync methods ────────────────────────────────────────────────────────────
  async syncActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new import_obsidian.Notice("No active note open");
      return;
    }
    await this.syncFile(file);
  }
  async syncIfTagged(file) {
    var _a, _b;
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = (_b = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a.tags) != null ? _b : [];
    if (!tags.includes(this.settings.syncTag))
      return;
    await this.syncFile(file);
  }
  async syncAllTagged() {
    if (!this.validateSettings())
      return;
    const files = this.app.vault.getMarkdownFiles();
    const tagged = this.settings.syncMode === "all" ? files : files.filter((f) => {
      var _a, _b;
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = (_b = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a.tags) != null ? _b : [];
      return tags.includes(this.settings.syncTag);
    });
    if (!tagged.length) {
      new import_obsidian.Notice(this.settings.syncMode === "all" ? "No notes found in vault" : `No notes tagged with "${this.settings.syncTag}" found`);
      return;
    }
    new import_obsidian.Notice(`Syncing ${tagged.length} notes...`);
    let synced = 0;
    let failed = 0;
    for (const file of tagged) {
      const ok = await this.syncFile(file, true);
      if (ok)
        synced++;
      else
        failed++;
      await new Promise((r) => setTimeout(r, 300));
    }
    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    this.updateStatusBar();
    new import_obsidian.Notice(`Second Brain: ${synced} synced${failed ? `, ${failed} failed` : ""}`);
  }
  async syncFile(file, silent = false) {
    var _a, _b, _c, _d, _e, _f;
    if (!this.validateSettings())
      return false;
    const raw = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = (_a = cache == null ? void 0 : cache.frontmatter) != null ? _a : {};
    const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
    const title = file.basename;
    const noteTags = (_b = frontmatter.tags) != null ? _b : [];
    const fullContent = `${title}

${body}`;
    const chunks = chunkText(fullContent, this.settings.chunkSize, this.settings.chunkOverlap);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload = {
          content: chunks.length > 1 ? `${chunks[i]} [chunk ${i + 1}/${chunks.length}]` : chunks[i],
          source: "obsidian",
          tags: [...noteTags, "obsidian", (_d = (_c = file.parent) == null ? void 0 : _c.name) != null ? _d : ""].filter(Boolean)
        };
        const response = await (0, import_obsidian.requestUrl)({
          url: `${this.settings.workerUrl}/capture`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.authToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          throw: false
        });
        if (response.status !== 200) {
          if (!silent)
            new import_obsidian.Notice(`Second Brain error: ${(_f = (_e = response.json) == null ? void 0 : _e.error) != null ? _f : response.status}`);
          return false;
        }
        if (i < chunks.length - 1)
          await new Promise((r) => setTimeout(r, 200));
      }
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this.updateStatusBar();
      if (!silent) {
        const chunkNote = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
        new import_obsidian.Notice(`\u2713 Saved "${title}" to Second Brain${chunkNote}`);
      }
      return true;
    } catch (e) {
      if (!silent)
        new import_obsidian.Notice("Second Brain: failed to connect to Worker");
      console.error("Second Brain sync error:", e);
      return false;
    }
  }
  // ── Sidebar ─────────────────────────────────────────────────────────────────
  async activateSidebar() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  // ── Helpers ─────────────────────────────────────────────────────────────────
  validateSettings() {
    if (!this.settings.workerUrl) {
      new import_obsidian.Notice("Second Brain: Worker URL not set. Go to Settings to configure.");
      return false;
    }
    if (!this.settings.authToken) {
      new import_obsidian.Notice("Second Brain: Auth token not set. Go to Settings to configure.");
      return false;
    }
    return true;
  }
  updateStatusBar() {
    if (!this.statusBar)
      return;
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
};
var SecondBrainSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Second Brain Settings" });
    containerEl.createEl("h3", { text: "Connection" });
    new import_obsidian.Setting(containerEl).setName("Worker URL").setDesc("Your Cloudflare Worker URL \u2014 e.g. https://second-brain.yourname.workers.dev").addText(
      (text) => text.setPlaceholder("https://second-brain.yourname.workers.dev").setValue(this.plugin.settings.workerUrl).onChange(async (value) => {
        this.plugin.settings.workerUrl = value.trim().replace(/\/$/, "");
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Auth token").setDesc("Your AUTH_TOKEN Worker secret. Keep this private.").addText((text) => {
      text.setPlaceholder("paste your token here").setValue(this.plugin.settings.authToken).onChange(async (value) => {
        this.plugin.settings.authToken = value.trim();
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
      return text;
    });
    new import_obsidian.Setting(containerEl).setName("Test connection").setDesc("Verify your Worker URL and token are correct").addButton(
      (btn) => btn.setButtonText("Test").onClick(async () => {
        if (!this.plugin.validateSettings())
          return;
        try {
          const response = await (0, import_obsidian.requestUrl)({
            url: `${this.plugin.settings.workerUrl}/list?n=1`,
            headers: { Authorization: `Bearer ${this.plugin.settings.authToken}` },
            throw: false
          });
          if (response.status === 200) {
            new import_obsidian.Notice("Second Brain: connected successfully");
          } else if (response.status === 401) {
            new import_obsidian.Notice("Second Brain: auth token is wrong");
          } else {
            new import_obsidian.Notice(`Second Brain: unexpected status ${response.status}`);
          }
        } catch (e) {
          new import_obsidian.Notice("Second Brain: could not reach Worker \u2014 check the URL");
        }
      })
    );
    containerEl.createEl("h3", { text: "Sync behaviour" });
    new import_obsidian.Setting(containerEl).setName("Sync mode").setDesc("Sync all notes in your vault, or only notes with a specific tag.").addDropdown((dropdown) => {
      dropdown.addOption("tagged", "Tagged notes only").addOption("all", "All notes").setValue(this.plugin.settings.syncMode).onChange(async (value) => {
        this.plugin.settings.syncMode = value;
        await this.plugin.saveSettings();
        this.display();
      });
    });
    if (this.plugin.settings.syncMode === "tagged") {
      new import_obsidian.Setting(containerEl).setName("Sync tag").setDesc("Only notes with this tag in their frontmatter will be synced. Default: brain").addText(
        (text) => text.setPlaceholder("brain").setValue(this.plugin.settings.syncTag).onChange(async (value) => {
          this.plugin.settings.syncTag = value.trim() || "brain";
          await this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Auto-sync on save").setDesc(this.plugin.settings.syncMode === "all" ? "Automatically sync every note when you save it." : "Automatically sync tagged notes when you save them.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
        this.plugin.settings.autoSync = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Chunking" });
    containerEl.createEl("p", {
      text: "Long notes are split into overlapping segments so each part gets a clean embedding. Short notes are stored as-is.",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("Chunk size (characters)").setDesc("Maximum characters per chunk. Default: 1600 (~400 tokens)").addSlider(
      (slider) => slider.setLimits(400, 4e3, 100).setValue(this.plugin.settings.chunkSize).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.chunkSize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Chunk overlap (characters)").setDesc("Overlap between chunks to preserve context at boundaries. Default: 200").addSlider(
      (slider) => slider.setLimits(0, 500, 50).setValue(this.plugin.settings.chunkOverlap).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.chunkOverlap = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Display" });
    new import_obsidian.Setting(containerEl).setName("Show sync status in status bar").setDesc("Shows the last sync time in the Obsidian status bar").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showSyncStatus).onChange(async (value) => {
        this.plugin.settings.showSyncStatus = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Actions" });
    new import_obsidian.Setting(containerEl).setName("Sync now").setDesc(this.plugin.settings.syncMode === "all" ? "Sync all notes in your vault to your Second Brain" : `Sync all notes tagged with "${this.plugin.settings.syncTag}" to your Second Brain`).addButton(
      (btn) => btn.setButtonText("Sync all").setCta().onClick(() => this.plugin.syncAllTagged())
    );
    if (this.plugin.settings.lastSyncTime) {
      const date = new Date(this.plugin.settings.lastSyncTime);
      containerEl.createEl("p", {
        text: `Last synced: ${date.toLocaleString()}`,
        cls: "setting-item-description"
      });
    }
  }
};
