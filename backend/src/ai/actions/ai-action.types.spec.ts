import {
  BULK_APPROVAL_THRESHOLD,
  resolveApprovalMode,
} from "./ai-action.types";

describe("resolveApprovalMode", () => {
  it("defaults small batches (below the threshold) to per-item review", () => {
    for (let count = 1; count < BULK_APPROVAL_THRESHOLD; count++) {
      expect(resolveApprovalMode(undefined, count)).toBe("individual");
    }
  });

  it("defaults to bulk once the batch reaches the threshold", () => {
    expect(resolveApprovalMode(undefined, BULK_APPROVAL_THRESHOLD)).toBe(
      "bulk",
    );
    expect(resolveApprovalMode(undefined, BULK_APPROVAL_THRESHOLD + 1)).toBe(
      "bulk",
    );
  });

  it("switches to bulk exactly at 6 items", () => {
    expect(BULK_APPROVAL_THRESHOLD).toBe(6);
    expect(resolveApprovalMode(undefined, 5)).toBe("individual");
    expect(resolveApprovalMode(undefined, 6)).toBe("bulk");
  });

  it("honours an explicit individual request at any count", () => {
    expect(resolveApprovalMode("individual", 1)).toBe("individual");
    expect(resolveApprovalMode("individual", 5)).toBe("individual");
    expect(resolveApprovalMode("individual", 25)).toBe("individual");
  });

  it("never produces a bulk card for a small batch, even when bulk is requested", () => {
    // Bulk is the automatic default at scale, not a small-batch override: a
    // 1-5 item batch always stays per-item.
    expect(resolveApprovalMode("bulk", 3)).toBe("individual");
    expect(resolveApprovalMode("bulk", 6)).toBe("bulk");
  });
});
