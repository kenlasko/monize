import { readFileSync } from "fs";
import { join } from "path";

import { APP_ID } from "./app-id";

const builderConfig = readFileSync(
  join(__dirname, "..", "..", "electron-builder.yml"),
  "utf8",
);

describe("APP_ID", () => {
  it("is the appId the installer stamps on the shortcuts", () => {
    const declared = /^appId:\s*(\S+)\s*$/m.exec(builderConfig);
    expect(declared?.[1]).toBe(APP_ID);
  });

  it("is a reverse-DNS id Windows accepts as an AppUserModelID", () => {
    // No spaces, at most 128 characters, dot-separated segments.
    expect(APP_ID).toMatch(/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/);
    expect(APP_ID.length).toBeLessThanOrEqual(128);
  });
});
