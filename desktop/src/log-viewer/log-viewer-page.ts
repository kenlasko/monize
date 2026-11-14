/**
 * The log viewer page's only script, loaded by `log-viewer.html` under a CSP
 * that allows no inline script. Every line goes through `textContent`, so a
 * log line is never parsed as markup. Compiled by `tsconfig.splash.json` with
 * the DOM library; wrapped in a function because both page scripts are plain
 * scripts of one program and would otherwise share their names.
 */
(() => {
  interface Source {
    id: string;
    label: string;
  }
  interface Text {
    title: string;
    sourceLabel: string;
    pause: string;
    refresh: string;
    empty: string;
    missing: string;
    failed: string;
  }
  interface Bridge {
    listSources(): Promise<unknown>;
    readTail(source: string, lines: number): Promise<unknown>;
    subscribe(listener: () => void): void;
  }

  const LINES = 500;

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`log-viewer.html has no #${id}`);
    return element as T;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function asSetup(value: unknown): { sources: Source[]; text: Text } | null {
    if (!isRecord(value) || !Array.isArray(value.sources)) return null;
    const text = value.text;
    if (!isRecord(text)) return null;
    const keys = [
      "title",
      "sourceLabel",
      "pause",
      "refresh",
      "empty",
      "missing",
      "failed",
    ];
    if (!keys.every((key) => typeof text[key] === "string")) return null;
    const sources: Source[] = [];
    for (const entry of value.sources) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.label !== "string"
      ) {
        return null;
      }
      sources.push({ id: entry.id, label: entry.label });
    }
    return { sources, text: text as unknown as Text };
  }

  async function start(): Promise<void> {
    const bridge = (window as unknown as { monizeLogs?: Bridge }).monizeLogs;
    if (bridge === undefined) return;
    const setup = asSetup(await bridge.listSources());
    if (setup === null) return;
    const { sources, text } = setup;

    document.title = text.title;
    byId("source-label").textContent = text.sourceLabel;
    byId("refresh").textContent = text.refresh;
    byId("pause-label").textContent = text.pause;
    const select = byId<HTMLSelectElement>("source");
    for (const source of sources) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.label;
      select.appendChild(option);
    }
    const log = byId("log");
    const note = byId("note");
    const pause = byId<HTMLInputElement>("pause");

    async function refresh(): Promise<void> {
      const answer = await bridge?.readTail(select.value, LINES);
      if (!isRecord(answer) || answer.ok !== true) {
        note.textContent = text.failed;
        return;
      }
      const lines = Array.isArray(answer.lines)
        ? answer.lines.filter(
            (line): line is string => typeof line === "string",
          )
        : [];
      const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
      log.textContent = lines.join("\n");
      note.textContent =
        answer.found !== true
          ? text.missing
          : lines.length === 0
            ? text.empty
            : "";
      if (atEnd) log.scrollTop = log.scrollHeight;
    }

    select.addEventListener("change", () => void refresh());
    byId("refresh").addEventListener("click", () => void refresh());
    bridge.subscribe(() => {
      if (!pause.checked) void refresh();
    });
    await refresh();
    log.scrollTop = log.scrollHeight;
  }

  void start();
})();
