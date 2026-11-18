/**
 * The "Set up another device" page's only script, loaded by `lan-setup.html`
 * under a CSP that allows no inline script and images only from `data:`.
 * Every string goes through `textContent`; the QR codes are `data:` URLs the
 * main process drew (`shell/lan-setup-view.ts`). Compiled by
 * `tsconfig.splash.json` with the DOM library, and wrapped in a function
 * because the page scripts are plain scripts of one program.
 */
(() => {
  interface Platform {
    name: string;
    steps: string;
  }
  interface View {
    running: boolean;
    text: Record<string, unknown> & { platforms: Platform[] };
    primaryUrl: string | null;
    otherUrls: string[];
    downloadUrl: string | null;
    fingerprint: string | null;
    addressQr: string | null;
    downloadQr: string | null;
  }
  interface Bridge {
    view(): Promise<unknown>;
    saveRoot(): Promise<unknown>;
    replaceRoot(): Promise<unknown>;
    subscribe(listener: () => void): void;
  }

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`lan-setup.html has no #${id}`);
    return element as T;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function asView(value: unknown): View | null {
    if (!isRecord(value) || typeof value.running !== "boolean") return null;
    if (!isRecord(value.text) || !Array.isArray(value.text.platforms)) {
      return null;
    }
    return value as unknown as View;
  }

  function str(view: View, key: string): string {
    const value = view.text[key];
    return typeof value === "string" ? value : "";
  }

  function setText(id: string, value: string | null): void {
    byId(id).textContent = value ?? "";
  }

  function setImage(id: string, url: string | null, alt: string): void {
    const image = byId<HTMLImageElement>(id);
    // Only the main process's own data: URLs; anything else is dropped.
    if (url !== null && url.startsWith("data:image/svg+xml;base64,")) {
      image.src = url;
      image.alt = alt;
      image.hidden = false;
    } else {
      image.removeAttribute("src");
      image.hidden = true;
    }
  }

  function render(view: View): void {
    document.title = str(view, "setupTitle");
    setText("title", str(view, "setupTitle"));
    setText("intro", str(view, "setupIntro"));
    const note = byId("note");
    const message = view.running
      ? (view.text.noMdnsNote as string | null)
      : str(view, "notRunning");
    note.textContent = message ?? "";
    note.hidden = message === null || message === "";
    byId("steps").hidden = !view.running;

    setText("step-certificate", str(view, "stepCertificate"));
    setText("step-certificate-body", str(view, "stepCertificateBody"));
    setImage("download-qr", view.downloadQr, view.downloadUrl ?? "");
    setText("download-url", view.downloadUrl);
    setText("save", str(view, "saveCertificate"));
    setText("fingerprint-label", str(view, "fingerprint"));
    setText("fingerprint", view.fingerprint);
    setText("platforms-heading", str(view, "platformsHeading"));
    const platforms = byId("platforms");
    platforms.replaceChildren(
      // One <div> per platform (allowed inside <dl>), so the CSS grid lays
      // the platforms out side by side as pairs.
      ...view.text.platforms.map((platform) => {
        const group = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = platform.name;
        const detail = document.createElement("dd");
        detail.textContent = platform.steps;
        group.append(term, detail);
        return group;
      }),
    );

    setText("step-open", str(view, "stepOpen"));
    setText("step-open-body", str(view, "stepOpenBody"));
    setImage("address-qr", view.addressQr, view.primaryUrl ?? "");
    setText("primary-url", view.primaryUrl);
    setText(
      "other-label",
      view.otherUrls.length > 0 ? str(view, "otherAddresses") : "",
    );
    byId("other-urls").replaceChildren(
      ...view.otherUrls.map((url) => {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = url;
        item.append(code);
        return item;
      }),
    );

    setText("warning-heading", str(view, "warningHeading"));
    setText("warning-body", str(view, "warningBody"));
    setText("warning-recovery", str(view, "warningRecovery"));

    setText("replace-heading", str(view, "replaceHeading"));
    setText("replace-body", str(view, "replaceBody"));
    setText("replace", str(view, "replaceButton"));
  }

  const bridge = (window as unknown as { monizeLanSetup?: Bridge })
    .monizeLanSetup;
  if (bridge === undefined) return;

  async function refresh(): Promise<void> {
    const view = asView(await bridge?.view());
    if (view !== null) render(view);
  }

  byId("save").addEventListener("click", () => void bridge.saveRoot());
  byId("replace").addEventListener(
    "click",
    () => void bridge.replaceRoot().then(refresh),
  );
  bridge.subscribe(() => void refresh());
  void refresh();
})();
