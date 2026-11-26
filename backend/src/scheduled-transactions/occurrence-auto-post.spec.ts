import { BadRequestException } from "@nestjs/common";
import {
  assertOverrideAutoPostAllowed,
  occurrenceAutoPosts,
} from "./occurrence-auto-post";

describe("occurrenceAutoPosts", () => {
  const manual = { isActive: true, autoPost: false, amountIsEstimated: false };
  const auto = { isActive: true, autoPost: true, amountIsEstimated: false };
  const estimated = {
    isActive: true,
    autoPost: false,
    amountIsEstimated: true,
  };

  it("follows the schedule when the occurrence has no override or no choice", () => {
    expect(occurrenceAutoPosts(auto, null)).toBe(true);
    expect(occurrenceAutoPosts(manual, null)).toBe(false);
    expect(occurrenceAutoPosts(auto, { autoPost: null, amount: -5 })).toBe(
      true,
    );
    expect(occurrenceAutoPosts(manual, { autoPost: null })).toBe(false);
  });

  it("lets the occurrence's own choice win both ways", () => {
    expect(occurrenceAutoPosts(manual, { autoPost: true })).toBe(true);
    expect(occurrenceAutoPosts(auto, { autoPost: false })).toBe(false);
  });

  it("never auto-posts an inactive schedule", () => {
    expect(
      occurrenceAutoPosts({ ...auto, isActive: false }, { autoPost: true }),
    ).toBe(false);
  });

  it("auto-posts an estimated schedule's occurrence only when it opts in and states the amount", () => {
    expect(occurrenceAutoPosts(estimated, null)).toBe(false);
    expect(occurrenceAutoPosts(estimated, { autoPost: true })).toBe(false);
    expect(
      occurrenceAutoPosts(estimated, { autoPost: true, amount: null }),
    ).toBe(false);
    expect(
      occurrenceAutoPosts(estimated, { autoPost: true, amount: -80 }),
    ).toBe(true);
    expect(
      occurrenceAutoPosts(estimated, { autoPost: true, isSplit: true }),
    ).toBe(true);
    // A stated amount alone does not opt in.
    expect(occurrenceAutoPosts(estimated, { amount: -80 })).toBe(false);
  });

  it("does not let a legacy auto_post = true on an estimated row post a stated occurrence", () => {
    expect(
      occurrenceAutoPosts({ ...estimated, autoPost: true }, { amount: -80 }),
    ).toBe(false);
  });
});

describe("assertOverrideAutoPostAllowed", () => {
  it("refuses opting an estimated occurrence in while it follows the estimate", () => {
    expect(() =>
      assertOverrideAutoPostAllowed(
        { amountIsEstimated: true },
        { autoPost: true, amount: null },
      ),
    ).toThrow(BadRequestException);
  });

  it("accepts every other combination", () => {
    expect(() =>
      assertOverrideAutoPostAllowed(
        { amountIsEstimated: true },
        { autoPost: true, amount: -80 },
      ),
    ).not.toThrow();
    expect(() =>
      assertOverrideAutoPostAllowed(
        { amountIsEstimated: true },
        { autoPost: false },
      ),
    ).not.toThrow();
    expect(() =>
      assertOverrideAutoPostAllowed(
        { amountIsEstimated: false },
        { autoPost: true },
      ),
    ).not.toThrow();
  });
});
