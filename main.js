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
  autoSyncDelay: 5e3,
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: true,
  lastSyncTime: null,
  importFolder: "_Second Brain/Inbox",
  importTag: "obsidian-inbox",
  importLimit: 20,
  pullOnStartup: false,
  importedIds: []
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
    this.debounceTimers = /* @__PURE__ */ new Map();
    this.syncingFiles = /* @__PURE__ */ new Set();
    this.isImporting = false;
  }
  async onload() {
    await this.loadSettings();
    if (this.settings.showSyncStatus) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatusBar();
    }
    this.addRibbonIcon("brain", "Sync current note to Second Brain", () => {
      this.syncActiveNote();
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
      name: "Sync all notes to Second Brain",
      callback: () => this.syncAllTagged()
    });
    this.addCommand({
      id: "import-memories-from-second-brain",
      name: "Import memories from Second Brain",
      callback: async () => {
        await this.importMemories(false);
      }
    });
    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", async (file) => {
          if (file instanceof import_obsidian.TFile && file.extension === "md") {
            await this.debouncedSyncIfTagged(file);
          }
        })
      );
    }
    if (this.settings.pullOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.importMemories(true).catch((e) => {
          console.error("Second Brain automatic import failed:", e);
          new import_obsidian.Notice("Automatic memory import failed.");
        });
      });
    }
    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
  }
  // FIX 1: removed onunload that called detachLeavesOfType
  // Obsidian handles leaf lifecycle automatically
  // ── Sync methods ────────────────────────────────────────────────────────────
  async syncActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new import_obsidian.Notice("No active note open");
      return;
    }
    await this.syncFile(file);
  }
  async debouncedSyncIfTagged(file) {
    if (this.syncingFiles.has(file.path))
      return;
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer)
      clearTimeout(existingTimer);
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(file.path);
      await this.syncIfTagged(file);
    }, this.settings.autoSyncDelay);
    this.debounceTimers.set(file.path, timer);
  }
  async syncIfTagged(file) {
    var _a, _b;
    if (this.settings.syncMode === "all") {
      await this.syncFile(file, true);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = (_b = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a.tags) != null ? _b : [];
    if (!tags.includes(this.settings.syncTag))
      return;
    await this.syncFile(file, true);
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
    let synced = 0, failed = 0;
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    if (!this.validateSettings())
      return false;
    if (this.syncingFiles.has(file.path))
      return true;
    this.syncingFiles.add(file.path);
    try {
      const raw = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = (_a = cache == null ? void 0 : cache.frontmatter) != null ? _a : {};
      const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
      const title = file.basename;
      const noteTags = (_b = frontmatter.tags) != null ? _b : [];
      const existingId = frontmatter["second-brain-id"];
      const fullContent = `${title}

${body}`;
      const chunks = chunkText(fullContent, this.settings.chunkSize, this.settings.chunkOverlap);
      if (existingId) {
        const payload = {
          id: existingId,
          addition: fullContent
        };
        const response = await (0, import_obsidian.requestUrl)({
          url: `${this.settings.workerUrl}/append`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.authToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          throw: false
        });
        if (response.status !== 200) {
          if (!silent) {
            const errorMsg = (_d = (_c = response.json) == null ? void 0 : _c.error) != null ? _d : `Server returned ${response.status}`;
            new import_obsidian.Notice(`Second Brain error: ${errorMsg}`);
          }
          return false;
        }
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.updateStatusBar();
        if (!silent) {
          new import_obsidian.Notice(`\u2713 Updated "${title}" in Second Brain`);
        }
        return true;
      } else {
        let capturedId;
        for (let i = 0; i < chunks.length; i++) {
          const payload = {
            content: chunks.length > 1 ? `${chunks[i]} [chunk ${i + 1}/${chunks.length}]` : chunks[i],
            source: "obsidian",
            tags: [...noteTags, "obsidian", (_f = (_e = file.parent) == null ? void 0 : _e.name) != null ? _f : ""].filter(Boolean)
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
            if (!silent) {
              const errorMsg = (_h = (_g = response.json) == null ? void 0 : _g.error) != null ? _h : `Server returned ${response.status}`;
              new import_obsidian.Notice(`Second Brain error: ${errorMsg}`);
            }
            return false;
          }
          if (i === 0 && ((_i = response.json) == null ? void 0 : _i.id)) {
            capturedId = response.json.id;
          }
          if (i < chunks.length - 1)
            await new Promise((r) => setTimeout(r, 200));
        }
        if (capturedId) {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm["second-brain-id"] = capturedId;
          });
        }
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.updateStatusBar();
        if (!silent) {
          const chunkNote = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
          new import_obsidian.Notice(`\u2713 Saved "${title}" to Second Brain${chunkNote}`);
        }
        return true;
      }
    } catch (e) {
      if (!silent)
        new import_obsidian.Notice("Second Brain: failed to connect to Worker");
      console.error("Second Brain sync error:", e);
      return false;
    } finally {
      this.syncingFiles.delete(file.path);
    }
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
  // ── Import helpers ─────────────────────────────────────────────────────────
  normalizeWorkerUrl(url) {
    return url.trim().replace(/\/+$/, "");
  }
  parseMemoryTags(tagsField) {
    let rawTags = [];
    if (Array.isArray(tagsField)) {
      rawTags = tagsField.map((t) => typeof t === "string" ? t.trim() : "").filter(Boolean);
    } else if (typeof tagsField === "string") {
      const trimmed = tagsField.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            rawTags = parsed.map((t) => typeof t === "string" ? t.trim() : "").filter(Boolean);
          } else {
            rawTags = [trimmed];
          }
        } catch (e) {
          rawTags = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
        }
      } else {
        rawTags = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
    return Array.from(new Set(rawTags));
  }
  sanitizeFileName(input) {
    if (!input || !input.trim())
      return "Untitled Memory";
    let clean = input.replace(/[\\/:*?"<>|]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    clean = clean.replace(/\.+$/, "").trim();
    if (clean.length > 100) {
      clean = clean.slice(0, 100).trim();
    }
    return clean || "Untitled Memory";
  }
  generateMemoryTitle(content, id) {
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
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
  getAvailableFilePath(folderPath, title) {
    const cleanFolder = folderPath.replace(/\/$/, "");
    let basePath = `${cleanFolder}/${title}.md`;
    let file = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(basePath));
    if (!file) {
      return (0, import_obsidian.normalizePath)(basePath);
    }
    let counter = 1;
    while (file) {
      basePath = `${cleanFolder}/${title} (${counter}).md`;
      file = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(basePath));
      counter++;
    }
    return (0, import_obsidian.normalizePath)(basePath);
  }
  async ensureFolderExists(folderPath) {
    const normalized = (0, import_obsidian.normalizePath)(folderPath);
    if (!normalized || normalized === "/" || normalized === ".")
      return;
    const parts = normalized.split("/");
    let currentPath = "";
    for (const part of parts) {
      if (!part)
        continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const fileOrFolder = this.app.vault.getAbstractFileByPath(currentPath);
      if (fileOrFolder) {
        if (fileOrFolder instanceof import_obsidian.TFile) {
          throw new Error(`Path "${currentPath}" exists but is a file, not a directory.`);
        }
      } else {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }
  async memoryAlreadyImported(memoryId) {
    var _a, _b;
    if ((_a = this.settings.importedIds) == null ? void 0 : _a.includes(memoryId)) {
      return true;
    }
    const markdownFiles = this.app.vault.getMarkdownFiles();
    for (const file of markdownFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const extId = (_b = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _b["external_memory_id"];
      if (extId === memoryId) {
        if (!this.settings.importedIds.includes(memoryId)) {
          this.settings.importedIds.push(memoryId);
          await this.saveSettings();
        }
        return true;
      }
    }
    return false;
  }
  async importMemories(silent = false) {
    var _a, _b, _c, _d;
    if (this.isImporting) {
      if (!silent)
        new import_obsidian.Notice("An import operation is already in progress.");
      return;
    }
    if (!this.settings.workerUrl) {
      if (!silent)
        new import_obsidian.Notice("Worker URL is not configured.");
      return;
    }
    if (!this.settings.authToken) {
      if (!silent)
        new import_obsidian.Notice("Auth token is not configured.");
      return;
    }
    this.isImporting = true;
    if (!silent)
      new import_obsidian.Notice("Starting import from Second Brain...");
    try {
      const workerUrl = this.normalizeWorkerUrl(this.settings.workerUrl);
      const authToken = this.settings.authToken;
      const importLimit = typeof this.settings.importLimit === "number" && this.settings.importLimit >= 1 ? this.settings.importLimit : 20;
      const importTag = ((_a = this.settings.importTag) == null ? void 0 : _a.trim()) || "obsidian-inbox";
      const importFolder = ((_b = this.settings.importFolder) == null ? void 0 : _b.trim()) || "_Second Brain/Inbox";
      const url = `${workerUrl}/list?n=${importLimit}&tag=${encodeURIComponent(importTag)}`;
      const response = await (0, import_obsidian.requestUrl)({
        url,
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json"
        },
        throw: false
      });
      if (response.status !== 200) {
        let errorMsg = `Server returned ${response.status}`;
        if (response.status === 401) {
          errorMsg = "Unauthorized. Please check your auth token.";
        }
        if (!silent)
          new import_obsidian.Notice(`Second Brain import failed: ${errorMsg}`);
        return;
      }
      const data = response.json;
      let memories = [];
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
          if (!silent)
            new import_obsidian.Notice("Invalid response format: No array of memories found.");
          return;
        }
      } else {
        if (!silent)
          new import_obsidian.Notice("Invalid response format: Response is not JSON.");
        return;
      }
      let importedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let settingsChanged = false;
      await this.ensureFolderExists(importFolder);
      for (const item of memories) {
        const id = item == null ? void 0 : item.id;
        const content = item == null ? void 0 : item.content;
        if (!id || !content || typeof id !== "string" || typeof content !== "string") {
          continue;
        }
        const rawTags = this.parseMemoryTags(item.tags);
        if (importTag && !rawTags.includes(importTag)) {
          skippedCount++;
          continue;
        }
        const alreadyImported = await this.memoryAlreadyImported(id);
        if (alreadyImported) {
          skippedCount++;
          continue;
        }
        try {
          const title = this.generateMemoryTitle(content, id);
          const path = this.getAvailableFilePath(importFolder, title);
          const cleanId = id.replace(/"/g, '\\"');
          const source = item.source && typeof item.source === "string" ? item.source.replace(/"/g, '\\"') : "external-memory";
          const createdAt = item.created_at != null ? String(item.created_at).replace(/"/g, '\\"') : "";
          const importedAt = (/* @__PURE__ */ new Date()).toISOString();
          const tagsYaml = rawTags.length > 0 ? "\ntags:\n" + rawTags.map((t) => `  - ${t}`).join("\n") : "";
          const firstLine = (_d = (_c = content.trim().split("\n")[0]) == null ? void 0 : _c.trim()) != null ? _d : "";
          const startsWithSameHeading = firstLine.startsWith("#") && firstLine.replace(/^#+\s*/, "").trim() === title;
          const frontmatter = `---
external_memory_id: "${cleanId}"
external_memory_source: "${source}"
external_memory_created_at: "${createdAt}"
imported_at: "${importedAt}"${tagsYaml}
---`;
          const body = startsWithSameHeading ? `

${content}` : `

# ${title}

${content}`;
          const fileContent = frontmatter + body;
          await this.app.vault.create(path, fileContent);
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
        if (failedCount > 0) {
          msg += ` ${failedCount} failed.`;
        }
        new import_obsidian.Notice(msg);
      } else {
        if (!silent) {
          let msg = "No new memories to import.";
          if (failedCount > 0) {
            msg += ` ${failedCount} failed.`;
          }
          new import_obsidian.Notice(msg);
        }
      }
    } catch (e) {
      console.error("Import memories critical error:", e);
      if (!silent)
        new import_obsidian.Notice("Second Brain import failed: check console logs for details.");
    } finally {
      this.isImporting = false;
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
    var _a, _b;
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Second Brain").setHeading();
    new import_obsidian.Setting(containerEl).setName("Connection").setHeading();
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
    new import_obsidian.Setting(containerEl).setName("Sync behaviour").setHeading();
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
        this.display();
      })
    );
    if (this.plugin.settings.autoSync) {
      new import_obsidian.Setting(containerEl).setName("Auto-sync delay (seconds)").setDesc("Wait this long after you stop typing before syncing. Default: 5 seconds").addSlider(
        (slider) => slider.setLimits(3, 30, 1).setValue(this.plugin.settings.autoSyncDelay / 1e3).setDynamicTooltip().onChange(async (value) => {
          this.plugin.settings.autoSyncDelay = value * 1e3;
          await this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Chunking").setDesc("Long notes are split into overlapping segments so each part gets a clean embedding. Short notes are stored as-is.").setHeading();
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
    new import_obsidian.Setting(containerEl).setName("Import behavior").setHeading();
    new import_obsidian.Setting(containerEl).setName("Import folder").setDesc("Folder where imported memories will be saved.").addText(
      (text) => text.setPlaceholder("_Second Brain/Inbox").setValue(this.plugin.settings.importFolder).onChange(async (value) => {
        this.plugin.settings.importFolder = value.trim() || "_Second Brain/Inbox";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Import tag").setDesc("Tag used to filter external memories to import.").addText(
      (text) => text.setPlaceholder("obsidian-inbox").setValue(this.plugin.settings.importTag).onChange(async (value) => {
        this.plugin.settings.importTag = value.trim() || "obsidian-inbox";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Import limit").setDesc("Maximum number of memories to fetch per import.").addText(
      (text) => text.setPlaceholder("20").setValue(String(this.plugin.settings.importLimit)).onChange(async (value) => {
        const parsed = parseInt(value.trim(), 10);
        if (isNaN(parsed) || parsed < 1) {
          new import_obsidian.Notice("Import limit must be a positive number");
          text.setValue(String(this.plugin.settings.importLimit));
          return;
        }
        this.plugin.settings.importLimit = parsed;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Pull/import on startup").setDesc("Automatically pull memories from your Second Brain when Obsidian starts.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (value) => {
        this.plugin.settings.pullOnStartup = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Reset imported IDs cache").setDesc(`Clear the list of previously imported memory IDs. Currently contains ${(_b = (_a = this.plugin.settings.importedIds) == null ? void 0 : _a.length) != null ? _b : 0} ID(s).`).addButton(
      (btn) => btn.setButtonText("Reset cache").setWarning().onClick(async () => {
        this.plugin.settings.importedIds = [];
        await this.plugin.saveSettings();
        this.display();
        new import_obsidian.Notice("Imported IDs cache has been reset");
      })
    );
    new import_obsidian.Setting(containerEl).setName("Display").setHeading();
    new import_obsidian.Setting(containerEl).setName("Show sync status in status bar").setDesc("Shows the last sync time in the Obsidian status bar").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showSyncStatus).onChange(async (value) => {
        this.plugin.settings.showSyncStatus = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Actions").setHeading();
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
