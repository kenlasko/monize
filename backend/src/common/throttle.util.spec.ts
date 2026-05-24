import { rateLimit } from "./throttle.util";

describe("rateLimit", () => {
  const original = process.env.RATE_LIMIT_MAX;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = original;
    }
  });

  it("returns the default when RATE_LIMIT_MAX is unset", () => {
    delete process.env.RATE_LIMIT_MAX;
    expect(rateLimit(5)).toBe(5);
  });

  it("raises the limit when the override exceeds the default", () => {
    process.env.RATE_LIMIT_MAX = "100000";
    expect(rateLimit(5)).toBe(100000);
  });

  it("never lowers a limit below its default", () => {
    process.env.RATE_LIMIT_MAX = "2";
    expect(rateLimit(5)).toBe(5);
  });

  it("ignores a non-numeric override", () => {
    process.env.RATE_LIMIT_MAX = "not-a-number";
    expect(rateLimit(5)).toBe(5);
  });
});
