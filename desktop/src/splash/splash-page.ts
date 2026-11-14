/**
 * The splash page's only script, loaded by `splash.html` under a CSP that
 * allows no inline script. It renders the view the main process sends
 * (`shell/splash-view.ts`) and every field goes through `textContent`, so a
 * log line is never parsed as markup. Compiled by `tsconfig.splash.json`
 * with the DOM library, apart from the Node-side program.
 */

interface SplashViewData {
  title: string;
  detail: string;
  lines: string[];
  retryLabel: string;
  quitLabel: string;
  canRetry: boolean;
  canQuit: boolean;
  busy: boolean;
  /** 0 to 1, or null for a bar that runs without a fill. */
  progress: number | null;
}

interface SplashBridge {
  onView(listener: (view: unknown) => void): void;
  retry(): void;
  quit(): void;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`splash.html has no #${id}`);
  return element;
}

function asView(value: unknown): SplashViewData | null {
  if (typeof value !== "object" || value === null) return null;
  const view = value as Record<string, unknown>;
  const lines = view.lines;
  if (
    typeof view.title !== "string" ||
    typeof view.detail !== "string" ||
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === "string")
  ) {
    return null;
  }
  return {
    title: view.title,
    detail: view.detail,
    lines: lines as string[],
    retryLabel: typeof view.retryLabel === "string" ? view.retryLabel : "",
    quitLabel: typeof view.quitLabel === "string" ? view.quitLabel : "",
    canRetry: view.canRetry === true,
    canQuit: view.canQuit === true,
    busy: view.busy === true,
    progress: asProgress(view.progress),
  };
}

function asProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** Replays the title's fade when its text changes, not on every view. */
function setTitle(text: string): void {
  const title = byId("title");
  if (title.textContent === text) return;
  title.textContent = text;
  title.classList.remove("changed");
  void title.offsetWidth;
  title.classList.add("changed");
}

function renderProgress(progress: number | null): void {
  const bar = byId("progress");
  bar.dataset.mode = progress === null ? "indeterminate" : "determinate";
  byId("progress-fill").style.setProperty(
    "--progress",
    progress === null ? "" : `${(progress * 100).toFixed(1)}%`,
  );
}

function render(view: SplashViewData): void {
  document.body.dataset.state = view.busy ? "busy" : "stopped";
  setTitle(view.title);
  byId("detail").textContent = view.detail;
  renderProgress(view.progress);
  const log = byId("log");
  log.textContent = view.lines.join("\n");
  log.hidden = view.lines.length === 0;
  log.scrollTop = log.scrollHeight;
  byId("retry").textContent = view.retryLabel;
  byId("retry").hidden = !view.canRetry;
  byId("quit").textContent = view.quitLabel;
  byId("quit").hidden = !view.canQuit;
  byId("actions").hidden = !view.canRetry && !view.canQuit;
}

function start(): void {
  const bridge = (window as unknown as { monizeSplash?: SplashBridge })
    .monizeSplash;
  if (bridge === undefined) return;
  byId("retry").addEventListener("click", () => bridge.retry());
  byId("quit").addEventListener("click", () => bridge.quit());
  bridge.onView((value) => {
    const view = asView(value);
    if (view !== null) render(view);
  });
}

start();
