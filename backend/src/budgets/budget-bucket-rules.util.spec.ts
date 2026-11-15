import { BadRequestException } from "@nestjs/common";
import {
  checkBucketTarget,
  checkedBucketCarryCap,
  checkedBucketName,
} from "./budget-bucket-rules.util";
import { BudgetBucketTargetType } from "./entities/budget-bucket.entity";

const { PERCENT, AMOUNT } = BudgetBucketTargetType;

describe("budget-bucket-rules.util", () => {
  describe("checkedBucketName", () => {
    it("returns the trimmed name", () => {
      expect(checkedBucketName("  Save  ", [], null)).toBe("Save");
    });

    it.each(["", "   ", "x".repeat(51)])("refuses %j", (raw) => {
      expect(() => checkedBucketName(raw, [], null)).toThrow(
        BadRequestException,
      );
    });

    it("accepts 50 characters", () => {
      expect(checkedBucketName("x".repeat(50), [], null)).toHaveLength(50);
    });

    it("refuses a sibling name ignoring case and space", () => {
      expect(() =>
        checkedBucketName(" SAVE ", [{ id: "a", name: "save" }], null),
      ).toThrow("already has a bucket");
    });

    it("refuses against a sibling without an id", () => {
      expect(() => checkedBucketName("Save", [{ name: "save" }], null)).toThrow(
        BadRequestException,
      );
    });

    it("lets a bucket keep its own name", () => {
      expect(checkedBucketName("Save", [{ id: "a", name: "Save" }], "a")).toBe(
        "Save",
      );
    });
  });

  describe("checkBucketTarget", () => {
    it.each([
      [PERCENT, 0.01],
      [PERCENT, 100],
      [PERCENT, 12.5],
      [AMOUNT, 5000.123],
    ])("accepts %s %s", (type, value) => {
      expect(() => checkBucketTarget(type, value)).not.toThrow();
    });

    it.each([
      [PERCENT, 0],
      [AMOUNT, -1],
      [PERCENT, 100.01],
      [PERCENT, 10.123],
      [AMOUNT, NaN],
    ])("refuses %s %s", (type, value) => {
      expect(() => checkBucketTarget(type, value)).toThrow(BadRequestException);
    });
  });

  describe("checkedBucketCarryCap", () => {
    it("passes null through", () => {
      expect(checkedBucketCarryCap(false, null)).toBeNull();
    });
    it("returns a cap on a carrying bucket", () => {
      expect(checkedBucketCarryCap(true, 25)).toBe(25);
    });
    it("refuses a cap without carry-over", () => {
      expect(() => checkedBucketCarryCap(false, 25)).toThrow(
        "needs carry-over",
      );
    });
  });
});
