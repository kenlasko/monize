import { resolveListenHost } from "./listen-host";

describe("resolveListenHost", () => {
  it("returns undefined when unset", () => {
    expect(resolveListenHost(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty or blank value", () => {
    expect(resolveListenHost("")).toBeUndefined();
    expect(resolveListenHost("   ")).toBeUndefined();
  });

  it("returns the trimmed value when set", () => {
    expect(resolveListenHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveListenHost("  127.0.0.1 \n")).toBe("127.0.0.1");
  });
});
