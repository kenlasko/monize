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
  };
}

function render(view: SplashViewData): void {
  byId("title").textContent = view.title;
  byId("detail").textContent = view.detail;
  byId("spinner").hidden = !view.busy;
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
