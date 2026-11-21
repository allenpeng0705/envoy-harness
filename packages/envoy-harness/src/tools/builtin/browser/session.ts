/**
 * Process-local Playwright browser session manager.
 *
 * Injectable for unit tests via {@link setBrowserSessionManager}.
 * Playwright is an optional peer dependency — missing install yields
 * a clear error pointing at `playwright` + browser download.
 */

export interface BrowserConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface BrowserNetworkEntry {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  timestamp: number;
}

export interface BrowserSnapshotRef {
  ref: string;
  role?: string;
  name?: string;
  selector: string;
}

export interface BrowserPageHandle {
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number },
  ): Promise<void>;
  accessibilitySnapshot(): Promise<unknown>;
  click(target: { selector?: string; ref?: string }): Promise<void>;
  type(
    target: { selector?: string; ref?: string },
    text: string,
    options?: { clear?: boolean },
  ): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  url(): string;
  setRefs(refs: ReadonlyArray<BrowserSnapshotRef>): void;
  resolveRef(ref: string): string | undefined;
  getConsole(limit?: number): BrowserConsoleEntry[];
  getNetwork(limit?: number): BrowserNetworkEntry[];
}

export interface BrowserSessionManager {
  ensurePage(
    key: string,
    opts?: { headed?: boolean },
  ): Promise<BrowserPageHandle>;
  getPage(key: string): BrowserPageHandle | undefined;
  close(key: string): Promise<void>;
  closeAll(): Promise<void>;
}

const PLAYWRIGHT_MISSING =
  "Playwright is not installed. Run `npm i playwright` (or install the " +
  "optionalDependency) then `npx playwright install chromium`.";

/** Minimal Playwright surface — avoid hard compile dep on the optional package. */
interface PwPage {
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<unknown>;
  accessibility?: {
    snapshot?(options?: { interestingOnly?: boolean }): Promise<unknown>;
  };
  /** Playwright ≥1.49; preferred once accessibility.snapshot is gone. */
  locator(selector: string): {
    ariaSnapshot?(): Promise<string>;
    first(): {
      click(): Promise<void>;
      fill(text: string): Promise<void>;
    };
    click(): Promise<void>;
    fill(text: string): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  screenshot(options?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
  url(): string;
  on(event: string, handler: (...args: never[]) => void): void;
  close(): Promise<void>;
}

interface PwBrowserContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwBrowser {
  newContext(): Promise<PwBrowserContext>;
  close(): Promise<void>;
}

interface PwModule {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<PwBrowser>;
  };
}

async function loadPlaywright(): Promise<PwModule> {
  try {
    return (await import("playwright")) as unknown as PwModule;
  } catch {
    throw new Error(PLAYWRIGHT_MISSING);
  }
}

const MAX_RING = 200;

class PlaywrightPageHandle implements BrowserPageHandle {
  private refs = new Map<string, string>();
  private consoleEntries: BrowserConsoleEntry[] = [];
  private networkEntries: BrowserNetworkEntry[] = [];

  constructor(private readonly page: PwPage) {
    this.page.on("console", ((msg: { type(): string; text(): string }) => {
      this.consoleEntries.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (this.consoleEntries.length > MAX_RING) {
        this.consoleEntries.splice(0, this.consoleEntries.length - MAX_RING);
      }
    }) as (...args: never[]) => void);
    this.page.on("response", ((res: {
      url(): string;
      status(): number;
      request(): { method(): string; resourceType(): string };
    }) => {
      const req = res.request();
      this.networkEntries.push({
        method: req.method(),
        url: res.url(),
        status: res.status(),
        resourceType: req.resourceType(),
        timestamp: Date.now(),
      });
      if (this.networkEntries.length > MAX_RING) {
        this.networkEntries.splice(0, this.networkEntries.length - MAX_RING);
      }
    }) as (...args: never[]) => void);
  }

  async goto(
    url: string,
    options?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    },
  ): Promise<void> {
    await this.page.goto(url, {
      waitUntil: options?.waitUntil ?? "load",
      timeout: options?.timeoutMs ?? 30_000,
    });
  }

  async accessibilitySnapshot(): Promise<unknown> {
    const snap = this.page.accessibility?.snapshot;
    if (typeof snap === "function") {
      return snap.call(this.page.accessibility, { interestingOnly: true });
    }
    // Playwright 1.57+ removed accessibility.snapshot — fall back to
    // locator.ariaSnapshot YAML so browser_snapshot still returns text.
    const aria = this.page.locator(":root").ariaSnapshot;
    if (typeof aria === "function") {
      const yaml = await aria.call(this.page.locator(":root"));
      return { role: "WebArea", name: "", ariaSnapshot: yaml };
    }
    throw new Error(
      "This Playwright build has neither accessibility.snapshot nor " +
        "locator.ariaSnapshot. Install playwright@>=1.49 <1.57 or a " +
        "newer build that exposes ariaSnapshot.",
    );
  }

  private resolveTarget(target: {
    selector?: string;
    ref?: string;
  }): string {
    if (target.ref !== undefined && target.ref.length > 0) {
      const sel = this.resolveRef(target.ref);
      if (sel === undefined) {
        throw new Error(
          `Unknown ref "${target.ref}". Call browser_snapshot first and use a listed ref.`,
        );
      }
      return sel;
    }
    if (target.selector !== undefined && target.selector.length > 0) {
      return target.selector;
    }
    throw new Error("Provide selector or ref");
  }

  async click(target: { selector?: string; ref?: string }): Promise<void> {
    await this.page.locator(this.resolveTarget(target)).click();
  }

  async type(
    target: { selector?: string; ref?: string },
    text: string,
    options?: { clear?: boolean },
  ): Promise<void> {
    const loc = this.page.locator(this.resolveTarget(target));
    if (options?.clear) {
      await loc.fill(text);
    } else {
      await loc.click();
      await this.page.keyboard.type(text);
    }
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "png", fullPage: false });
  }

  url(): string {
    return this.page.url();
  }

  setRefs(refs: ReadonlyArray<BrowserSnapshotRef>): void {
    this.refs.clear();
    for (const r of refs) this.refs.set(r.ref, r.selector);
  }

  resolveRef(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  getConsole(limit = 50): BrowserConsoleEntry[] {
    return this.consoleEntries.slice(-Math.max(1, limit));
  }

  getNetwork(limit = 50): BrowserNetworkEntry[] {
    return this.networkEntries.slice(-Math.max(1, limit));
  }

  /** Underlying Playwright page (close path). */
  get rawPage(): PwPage {
    return this.page;
  }
}

/**
 * Resolve headed mode for a session key.
 * - Explicit `opts.headed` wins.
 * - Otherwise keep `previousHeaded` for this key.
 * - First open defaults to headless (`false`).
 */
export function resolveHeadedMode(
  opts: { headed?: boolean } | undefined,
  previousHeaded: boolean | undefined,
): boolean {
  if (opts?.headed !== undefined) return opts.headed === true;
  if (previousHeaded !== undefined) return previousHeaded;
  return false;
}

/** @deprecated Prefer {@link resolveHeadedMode}. */
export function headedModeForEnsure(
  opts: { headed?: boolean } | undefined,
): boolean {
  return resolveHeadedMode(opts, undefined);
}

class PlaywrightSessionManager implements BrowserSessionManager {
  /** One Chromium process per headed mode so sessions don't cross-kill. */
  private readonly browsers = new Map<boolean, PwBrowser>();
  private readonly pages = new Map<
    string,
    {
      handle: PlaywrightPageHandle;
      context: PwBrowserContext;
      headed: boolean;
    }
  >();

  private async launchBrowser(headed: boolean): Promise<PwBrowser> {
    const existing = this.browsers.get(headed);
    if (existing !== undefined) return existing;
    const pw = await loadPlaywright();
    try {
      const browser = await pw.chromium.launch({ headless: !headed });
      this.browsers.set(headed, browser);
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
        throw new Error(
          `${PLAYWRIGHT_MISSING} (browser binary missing: ${msg})`,
        );
      }
      throw err;
    }
  }

  private async maybeCloseBrowser(headed: boolean): Promise<void> {
    const stillUsed = [...this.pages.values()].some((p) => p.headed === headed);
    if (stillUsed) return;
    const browser = this.browsers.get(headed);
    if (browser === undefined) return;
    this.browsers.delete(headed);
    await browser.close().catch(() => undefined);
  }

  async ensurePage(
    key: string,
    opts?: { headed?: boolean },
  ): Promise<BrowserPageHandle> {
    const existing = this.pages.get(key);
    const headed = resolveHeadedMode(opts, existing?.headed);
    if (existing !== undefined && existing.headed === headed) {
      return existing.handle;
    }
    // Headed flip for this key only — other sessions keep their pages.
    if (existing !== undefined) {
      await this.close(key);
    }

    const browser = await this.launchBrowser(headed);
    const context = await browser.newContext();
    const page = await context.newPage();
    const handle = new PlaywrightPageHandle(page);
    this.pages.set(key, { handle, context, headed });
    return handle;
  }

  getPage(key: string): BrowserPageHandle | undefined {
    return this.pages.get(key)?.handle;
  }

  async close(key: string): Promise<void> {
    const entry = this.pages.get(key);
    if (entry === undefined) return;
    this.pages.delete(key);
    await entry.context.close().catch(() => undefined);
    await this.maybeCloseBrowser(entry.headed);
  }

  async closeAll(): Promise<void> {
    const keys = [...this.pages.keys()];
    for (const k of keys) await this.close(k);
    for (const headed of [...this.browsers.keys()]) {
      await this.maybeCloseBrowser(headed);
    }
  }
}

let manager: BrowserSessionManager = new PlaywrightSessionManager();

/** Override the process-local session manager (tests). */
export function setBrowserSessionManager(
  next: BrowserSessionManager | undefined,
): void {
  manager = next ?? new PlaywrightSessionManager();
}

export function getBrowserSessionManager(): BrowserSessionManager {
  return manager;
}

/** Stable key for one agent session + cwd. */
export function browserSessionKey(ctx: {
  cwd: string;
  session: { id: string };
}): string {
  return `${ctx.cwd}::${ctx.session.id}`;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "searchbox",
]);

function roleNameKey(role: string | undefined, name: string | undefined): string {
  return `${role ?? ""}\0${name ?? ""}`;
}

/**
 * Walk an a11y snapshot tree and assign `e1`, `e2`, … refs with
 * best-effort Playwright role selectors. Duplicate role+name pairs
 * get `>> nth=N` so refs stay unambiguous.
 */
export function collectSnapshotRefs(
  node: unknown,
  out: BrowserSnapshotRef[] = [],
  counter = { n: 0 },
  roleNameCounts = new Map<string, number>(),
): BrowserSnapshotRef[] {
  if (node === null || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  // ariaSnapshot fallback: no structured tree — no refs.
  if (typeof n["ariaSnapshot"] === "string") return out;

  const role = typeof n["role"] === "string" ? n["role"] : undefined;
  const name = typeof n["name"] === "string" ? n["name"] : undefined;
  const interactive = role !== undefined && INTERACTIVE_ROLES.has(role);
  if (interactive) {
    counter.n += 1;
    const ref = `e${counter.n}`;
    const key = roleNameKey(role, name);
    const nth = roleNameCounts.get(key) ?? 0;
    roleNameCounts.set(key, nth + 1);
    let selector: string;
    if (name !== undefined && name.length > 0 && role !== undefined) {
      const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      selector = `role=${role}[name="${escaped}"]`;
    } else if (role !== undefined) {
      selector = `role=${role}`;
    } else {
      selector = `text=${JSON.stringify(name ?? "")}`;
    }
    if (nth > 0) {
      selector = `${selector} >> nth=${nth}`;
    }
    out.push({
      ref,
      ...(role !== undefined ? { role } : {}),
      ...(name !== undefined ? { name } : {}),
      selector,
    });
  }
  const children = n["children"];
  if (Array.isArray(children)) {
    for (const child of children) {
      collectSnapshotRefs(child, out, counter, roleNameCounts);
    }
  }
  return out;
}

/**
 * Pretty-print a11y tree with refs annotated in DFS order
 * (matches {@link collectSnapshotRefs}).
 */
export function formatAccessibilityTree(
  node: unknown,
  refs: ReadonlyArray<BrowserSnapshotRef>,
  indent = 0,
  cursor = { i: 0 },
): string {
  if (node === null || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (typeof n["ariaSnapshot"] === "string") {
    return String(n["ariaSnapshot"]);
  }
  const role = typeof n["role"] === "string" ? n["role"] : "node";
  const name = typeof n["name"] === "string" ? n["name"] : "";
  const pad = "  ".repeat(indent);
  let refSuffix = "";
  if (INTERACTIVE_ROLES.has(role) && cursor.i < refs.length) {
    const match = refs[cursor.i];
    if (
      match !== undefined &&
      match.role === role &&
      (match.name ?? "") === name
    ) {
      refSuffix = ` [ref=${match.ref}]`;
      cursor.i += 1;
    }
  }
  const namePart = name.length > 0 ? ` "${name}"` : "";
  const lines = [`${pad}- ${role}${namePart}${refSuffix}`];
  const children = n["children"];
  if (Array.isArray(children)) {
    for (const child of children) {
      const sub = formatAccessibilityTree(child, refs, indent + 1, cursor);
      if (sub.length > 0) lines.push(sub);
    }
  }
  return lines.join("\n");
}
