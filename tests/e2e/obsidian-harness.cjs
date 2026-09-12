"use strict";

/** Real-enough Obsidian stub for e2e: HTTP-backed requestUrl, functional Modal/Setting/DOM. */

class Notice {
  constructor(message) {
    (globalThis.__obsidianTestNotices ??= []).push(message);
  }
}

class TFile {
  constructor(path = "note.md") {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.extension = this.name.includes(".") ? this.name.split(".").pop() ?? "" : "";
    this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
    const parts = path.split("/");
    this.parent = parts.length > 1 ? { name: parts.at(-2) ?? "" } : null;
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.data = {};
    /** @type {Map<string, { callback?: Function, editorCallback?: Function }>} */
    this.commands = new Map();
  }

  async loadData() { return this.data; }
  async saveData(data) { this.data = data; }
  // Real Obsidian RETAINS the EventRef until the plugin unloads. Unloading it inline
  // (the previous stub) silently deregistered every vault/workspace listener, so the
  // plugin's own event handlers — including the self-write sync-loop guard — never ran.
  registerEvent(event) { (this._eventRefs ??= []).push(event); return event; }
  register() {}
  registerView() {}
  addRibbonIcon() { return makeElement("button"); }
  addCommand(command) { this.commands.set(command.id, command); }
  addSettingTab() {}
  addStatusBarItem() { return makeElement("span"); }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeElement("div");
  }
}

class ItemView {
  constructor(leaf) {
    this.app = leaf?.app;
    this.contentEl = makeElement("div");
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = makeElement("div");
  }

  open() {
    if (this.app?.workspace) this.app.workspace._lastModal = this;
    if (typeof this.onOpen === "function") this.onOpen();
  }

  close() {
    if (typeof this.onClose === "function") this.onClose();
  }
}

class Setting {
  constructor(container) {
    this.container = container;
    this.controlEl = makeElement("div");
    container.appendChild(this.controlEl);
  }

  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }

  addText(callback) {
    const component = new TextComponent();
    callback(component);
    this.controlEl.appendChild(component.inputEl);
    return this;
  }

  addButton(callback) {
    const component = new ButtonComponent();
    callback(component);
    if (component.buttonEl) this.controlEl.appendChild(component.buttonEl);
    return this;
  }

  addDropdown(callback) {
    const component = new DropdownComponent();
    callback(component);
    this.controlEl.appendChild(component.selectEl);
    return this;
  }

  addToggle(callback) {
    callback(new ToggleComponent());
    return this;
  }

  addSlider(callback) {
    callback(new SliderComponent());
    return this;
  }
}

class TextComponent {
  constructor() {
    this.inputEl = makeElement("input");
    this.inputEl.type = "text";
  }
  setPlaceholder() { return this; }
  setValue(v) { this.inputEl.value = v; return this; }
  onChange(cb) {
    this.inputEl.addEventListener("change", () => cb(this.inputEl.value));
    return this;
  }
}

class ButtonComponent {
  constructor() {
    this.buttonEl = makeElement("button");
  }
  setButtonText(text) { this.buttonEl.textContent = text; return this; }
  setCta() { this.buttonEl.className = "mod-cta"; return this; }
  onClick(cb) {
    this.buttonEl.addEventListener("click", () => cb());
    return this;
  }
}

class DropdownComponent {
  constructor() {
    this.selectEl = makeElement("select");
  }
  addOption(value, display) {
    const opt = makeElement("option");
    opt.value = value;
    opt.textContent = display;
    this.selectEl.appendChild(opt);
    return this;
  }
  setValue(value) {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb) {
    this.selectEl.addEventListener("change", () => cb(this.selectEl.value));
    return this;
  }
}

class ToggleComponent {
  setValue() { return this; }
  onChange() { return this; }
}

class SliderComponent {
  setLimits() { return this; }
  setValue() { return this; }
  setDynamicTooltip() { return this; }
  onChange() { return this; }
}

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    value: "",
    children: [],
    classList: {
      add(...names) { names.forEach((n) => { if (!el.className.includes(n)) el.className = `${el.className} ${n}`.trim(); }); },
      remove() {},
    },
    style: {},
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    addEventListener(type, handler) {
      (el._listeners ??= []).push({ type, handler });
    },
    remove() {},
    setAttribute() {},
    empty() {
      el.children = [];
      el.textContent = "";
    },
    createEl(childTag, opts = {}) {
      const child = makeElement(childTag);
      if (opts.text) child.textContent = opts.text;
      if (opts.cls) child.className = opts.cls;
      el.appendChild(child);
      return child;
    },
    createDiv(opts = {}) {
      return el.createEl("div", opts);
    },
    querySelector(sel) {
      return queryTree(el, sel);
    },
    click() {
      for (const { type, handler } of el._listeners ?? []) {
        if (type === "click") handler();
      }
    },
  };
  return el;
}

function queryTree(root, sel) {
  if (sel === "select" && root.tagName === "SELECT") return root;
  if (sel === "button.mod-cta" && root.tagName === "BUTTON" && root.className.includes("mod-cta")) return root;
  if (sel === "button" && root.tagName === "BUTTON") return root;
  for (const child of root.children ?? []) {
    const hit = queryTree(child, sel);
    if (hit) return hit;
  }
  return null;
}

async function requestUrl(options) {
  const url = options.url;
  const init = {
    method: options.method ?? "GET",
    headers: options.headers,
  };
  if (options.body !== undefined) init.body = options.body;

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (options.throw === false) {
      return { status: 0, json: { ok: false, error: String(error) } };
    }
    throw error;
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (options.throw !== false && response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return { status: response.status, json };
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function setIcon() {}

module.exports = {
  Notice,
  TFile,
  Plugin,
  PluginSettingTab,
  ItemView,
  Modal,
  Setting,
  requestUrl,
  normalizePath,
  setIcon,
};
