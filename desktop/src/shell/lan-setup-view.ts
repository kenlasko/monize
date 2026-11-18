import qrcode from "qrcode-generator";

import { LanStatus } from "../lan/lan-service";
import { LAN_TEXT } from "./lan-strings";

/**
 * What the "Set up another device" window shows, as plain data: the page
 * (`lan-setup/lan-setup-page.ts`) puts every string through `textContent`
 * and every QR code into an `<img>` as a `data:` URL, so nothing in here is
 * ever parsed as markup by the page.
 */

/** Every string the page shows; plain data, because it crosses IPC. */
export type LanSetupText = Omit<typeof LAN_TEXT, "noMdnsName"> & {
  readonly noMdnsNote: string | null;
};

export interface LanSetupView {
  readonly running: boolean;
  readonly text: LanSetupText;
  /** The address to open, best first, and the rest. */
  readonly primaryUrl: string | null;
  readonly otherUrls: readonly string[];
  /** Where the device downloads the root certificate over plain HTTP. */
  readonly downloadUrl: string | null;
  readonly fingerprint: string | null;
  readonly addressQr: string | null;
  readonly downloadQr: string | null;
}

/** Quiet-zone modules around the code, as the QR specification asks. */
const MARGIN = 4;

/** A QR code for `text` as an SVG `data:` URL, dark modules on white. */
export function qrDataUrl(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const size = count + MARGIN * 2;
  const path: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        path.push(`M${col + MARGIN} ${row + MARGIN}h1v1h-1z`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges"><rect width="${size}" height="${size}" ` +
    `fill="#fff"/><path fill="#000" d="${path.join("")}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function textWith(noMdnsNote: string | null): LanSetupText {
  const { noMdnsName: _sentence, ...plain } = LAN_TEXT;
  return { ...plain, noMdnsNote };
}

export function lanSetupView(status: LanStatus): LanSetupView {
  if (status.kind !== "on") {
    return {
      running: false,
      text: textWith(null),
      primaryUrl: null,
      otherUrls: [],
      downloadUrl: null,
      fingerprint: null,
      addressQr: null,
      downloadQr: null,
    };
  }
  const [primaryUrl = null, ...otherUrls] = status.urls;
  const downloadUrl = status.downloadUrls[0] ?? null;
  return {
    running: true,
    text: textWith(
      status.label === null && status.mdnsProblem !== null
        ? LAN_TEXT.noMdnsName(status.mdnsProblem)
        : null,
    ),
    primaryUrl,
    otherUrls,
    downloadUrl,
    fingerprint: status.rootFingerprint,
    addressQr: primaryUrl === null ? null : qrDataUrl(primaryUrl),
    downloadQr: downloadUrl === null ? null : qrDataUrl(downloadUrl),
  };
}
