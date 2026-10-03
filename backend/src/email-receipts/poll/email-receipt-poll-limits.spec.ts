import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMAIL_RECEIPT_POLL_LIMIT_SPECS,
  resolveEmailReceiptPollLimits,
} from "./email-receipt-poll-limits";

const logger = () => ({ warn: jest.fn() });

describe("email receipt poll limits", () => {
  it("uses the documented defaults when unset", () => {
    const log = logger();
    expect(resolveEmailReceiptPollLimits({}, log)).toEqual({
      maxMessages: 50,
      maxMessageBytes: 2_000_000,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  describe.each(Object.entries(EMAIL_RECEIPT_POLL_LIMIT_SPECS))(
    "%s",
    (key, spec) => {
      const pick = (env: Record<string, unknown>, log = logger()) =>
        resolveEmailReceiptPollLimits(env, log)[
          key as keyof typeof EMAIL_RECEIPT_POLL_LIMIT_SPECS
        ];

      it.each(["1", "2"])("honors override %s", (raw) => {
        expect(pick({ [spec.envVar]: raw })).toBe(Number(raw));
      });
      it("accepts the upper bound", () => {
        expect(pick({ [spec.envVar]: String(spec.max) })).toBe(spec.max);
      });
      it.each([
        "0",
        "-1",
        "1.5",
        "bad",
        "Infinity",
        "99999999999999999999",
        true,
      ])("rejects invalid override %s", (raw) => {
        const log = logger();
        expect(pick({ [spec.envVar]: raw }, log)).toBe(spec.default);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining(spec.envVar),
        );
      });
      it("falls back when above the cap", () => {
        const log = logger();
        expect(pick({ [spec.envVar]: spec.max + 1 }, log)).toBe(spec.default);
        expect(log.warn).toHaveBeenCalled();
      });
    },
  );

  it("documents every knob and current default in .env.example, with no stale knobs", () => {
    const text = readFileSync(
      join(__dirname, "../../../../.env.example"),
      "utf8",
    );
    const documented = [
      ...text.matchAll(/^# (EMAIL_RECEIPTS_MAX_\w+)=(\d+)$/gm),
    ].map(([, name, value]) => [name, Number(value)]);
    expect(Object.fromEntries(documented)).toEqual(
      Object.fromEntries(
        Object.values(EMAIL_RECEIPT_POLL_LIMIT_SPECS).map((spec) => [
          spec.envVar,
          spec.default,
        ]),
      ),
    );
  });
});
