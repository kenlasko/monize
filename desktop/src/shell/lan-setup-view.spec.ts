import qrcode from "qrcode-generator";

import { LanStatus } from "../lan/lan-service";
import { lanSetupView, qrDataUrl } from "./lan-setup-view";
import { LAN_TEXT } from "./lan-strings";

const ON: LanStatus = {
  kind: "on",
  port: 3382,
  label: "monize",
  mdnsProblem: null,
  urls: [
    "https://monize.local:3382",
    "https://desktop-1.local:3382",
    "https://192.168.1.23:3382",
  ],
  downloadUrls: ["http://192.168.1.23:3382/monize-root.crt"],
  rootFingerprint: "AB:CD",
};

function svgOf(dataUrl: string): string {
  return Buffer.from(dataUrl.split(",")[1] as string, "base64").toString();
}

describe("lanSetupView", () => {
  it("leads with the mDNS address and lists the rest", () => {
    const view = lanSetupView(ON);
    expect(view.running).toBe(true);
    expect(view.primaryUrl).toBe("https://monize.local:3382");
    expect(view.otherUrls).toEqual([
      "https://desktop-1.local:3382",
      "https://192.168.1.23:3382",
    ]);
    expect(view.fingerprint).toBe("AB:CD");
    expect(view.text.noMdnsNote).toBeNull();
  });

  it("downloads the certificate from an IP address, which every phone resolves", () => {
    expect(lanSetupView(ON).downloadUrl).toBe(
      "http://192.168.1.23:3382/monize-root.crt",
    );
  });

  it("says why there is no monize.local", () => {
    const view = lanSetupView({
      ...ON,
      label: null,
      mdnsProblem: "port 5353 is in use",
      urls: ["https://192.168.1.23:3382"],
    });
    expect(view.text.noMdnsNote).toBe(
      LAN_TEXT.noMdnsName("port 5353 is in use"),
    );
    expect(view.primaryUrl).toBe("https://192.168.1.23:3382");
  });

  it("is plain data that survives IPC's structured clone", () => {
    for (const status of [ON, { kind: "off" } as LanStatus]) {
      const view = lanSetupView(status);
      expect(structuredClone(view)).toEqual(view);
    }
  });

  it("shows nothing to scan while local-network access is off", () => {
    const view = lanSetupView({ kind: "off" });
    expect(view.running).toBe(false);
    expect(view.addressQr).toBeNull();
    expect(view.downloadQr).toBeNull();
  });
});

describe("qrDataUrl", () => {
  it("draws the library's modules into a self-contained SVG", () => {
    const url = "https://monize.local:3382";
    const svg = svgOf(qrDataUrl(url));
    const code = qrcode(0, "M");
    code.addData(url, "Byte");
    code.make();
    let dark = 0;
    for (let row = 0; row < code.getModuleCount(); row++) {
      for (let col = 0; col < code.getModuleCount(); col++) {
        if (code.isDark(row, col)) dark++;
      }
    }
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<script|href=/);
  });
});
