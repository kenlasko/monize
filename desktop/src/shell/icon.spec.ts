import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { iconPathFor, trayResizeFor, WINDOWS_ICON } from "./icon";

describe("iconPathFor", () => {
  it("is the staged multi-size icon on Windows", () => {
    expect(iconPathFor("C:\\Monize\\resources", "win32")).toBe(
      "C:\\Monize\\resources\\shell\\icon.ico",
    );
  });

  it("is the web manifest's PNG elsewhere", () => {
    expect(iconPathFor("/opt/monize/resources", "linux")).toBe(
      "/opt/monize/resources/frontend/public/icons/icon-192x192.png",
    );
  });

  it("names a file the staging manifest puts there", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "staging-manifest.json"),
        "utf8",
      ),
    ) as { entries: { from: string; to: string }[] };
    const entry = manifest.entries.find(
      (candidate) => candidate.to === WINDOWS_ICON.join("/"),
    );
    expect(entry?.from).toBe("desktop/build/icon.ico");
    expect(existsSync(join(__dirname, "..", "..", "build", "icon.ico"))).toBe(
      true,
    );
  });
});

describe("trayResizeFor", () => {
  it("leaves an .ico whole and scales anything else to the tray size", () => {
    expect(trayResizeFor("C:\\x\\shell\\ICON.ICO")).toBeNull();
    expect(trayResizeFor("/x/icon-192x192.png")).toBe(16);
  });
});
