import type { Request } from "express";
import { psuContextOf } from "./psu-context.util";

function request(ip: string | undefined): Request {
  return { ip, socket: {} } as unknown as Request;
}

describe("psuContextOf", () => {
  it("carries the client address and the browser's user agent", () => {
    expect(psuContextOf(request("203.0.113.4"), "Mozilla/5.0")).toEqual({
      ipAddress: "203.0.113.4",
      userAgent: "Mozilla/5.0",
    });
  });

  it("strips the IPv4-mapped prefix through the deployment's one reader", () => {
    expect(psuContextOf(request("::ffff:203.0.113.4"), "UA")?.ipAddress).toBe(
      "203.0.113.4",
    );
  });

  it("is null when the address cannot be determined: sent as unattended, not invented", () => {
    expect(psuContextOf(request(undefined), "UA")).toBeNull();
  });

  it("names the product when the browser sent no user agent", () => {
    expect(psuContextOf(request("203.0.113.4"), undefined)?.userAgent).toBe(
      "Monize",
    );
    expect(psuContextOf(request("203.0.113.4"), "   ")?.userAgent).toBe(
      "Monize",
    );
  });

  it("bounds both values before they leave for the bank", () => {
    const context = psuContextOf(
      request("2001:db8::" + "f".repeat(100)),
      "u".repeat(999),
    );
    expect(context?.ipAddress.length).toBeLessThanOrEqual(64);
    expect(context?.userAgent).toHaveLength(256);
  });
});
