type RequestOptions = Record<string, unknown>;

declare global {
  // The Node test harness supplies these hooks before loading the bundled plugin.
  // They keep the production bundle dependent on Obsidian's requestUrl only.
  var __obsidianTestRequestUrl: ((options: RequestOptions) => Promise<unknown>) | undefined;
  var __obsidianTestNotices: string[] | undefined;
}

export async function requestUrl(options: RequestOptions): Promise<unknown> {
  if (!globalThis.__obsidianTestRequestUrl) {
    throw new Error("requestUrl called without a test handler");
  }
  return globalThis.__obsidianTestRequestUrl(options);
}

export class Notice {
  constructor(message: string) {
    (globalThis.__obsidianTestNotices ??= []).push(message);
  }
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: { name: string } | null;

  constructor(path = "note.md") {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.extension = this.name.includes(".") ? this.name.split(".").pop() ?? "" : "";
    this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
    const parts = path.split("/");
    this.parent = parts.length > 1 ? { name: parts.at(-2) ?? "" } : null;
  }
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  private data: unknown = {};
  private registered: Array<() => void> = [];

  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this.data;
  }

  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }

  registerEvent(event: { unload?: () => void }): void {
    this.registered.push(() => event.unload?.());
  }

  register(_event: unknown): void {
    // Obsidian's register() accepts cleanup callbacks and DOM event targets.
  }

  registerView(_type: string, _creator: unknown): void {}
  addRibbonIcon(_icon: string, _label: string, _callback: () => void): HTMLElement {
    return document.createElement("button");
  }
  addCommand(_command: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  addStatusBarItem(): HTMLElement {
    return document.createElement("span");
  }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: HTMLElement = document.createElement("div");

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class ItemView {
  app: unknown;
  contentEl: HTMLElement = document.createElement("div");

  constructor(leaf: { app?: unknown }) {
    this.app = leaf.app;
  }
}

export class Modal {
  app: unknown;
  contentEl: HTMLElement = document.createElement("div");

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(_container: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  setHeading(): this { return this; }
  addText(_callback: (text: TextComponent) => unknown): this { return this; }
  addButton(_callback: (button: ButtonComponent) => unknown): this { return this; }
  addDropdown(_callback: (dropdown: DropdownComponent) => unknown): this { return this; }
  addToggle(_callback: (toggle: ToggleComponent) => unknown): this { return this; }
  addSlider(_callback: (slider: SliderComponent) => unknown): this { return this; }
}

class TextComponent {
  inputEl: HTMLInputElement = document.createElement("input");
  setPlaceholder(_value: string): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => unknown): this { return this; }
}

class ButtonComponent {
  setButtonText(_value: string): this { return this; }
  setCta(): this { return this; }
  onClick(_callback: () => unknown): this { return this; }
}

class DropdownComponent {
  selectEl: HTMLSelectElement = document.createElement("select");
  addOption(_value: string, _display: string): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => unknown): this { return this; }
}

class ToggleComponent {
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => unknown): this { return this; }
}

class SliderComponent {
  setLimits(_min: number, _max: number, _step: number): this { return this; }
  setValue(_value: number): this { return this; }
  setDynamicTooltip(): this { return this; }
  onChange(_callback: (value: number) => unknown): this { return this; }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

export function setIcon(_element: HTMLElement, _icon: string): void {}

export interface App {}
export interface Editor {}
export interface MarkdownView { file: TFile; }
export interface RequestUrlResponse { status: number; json: unknown; }
export interface WorkspaceLeaf {}
