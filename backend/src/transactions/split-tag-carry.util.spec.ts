import { BadRequestException } from "@nestjs/common";
import { carrySplitTags, ExistingSplitLine } from "./split-tag-carry.util";

const tag = (id: string) => ({ id, name: `Tag ${id}` });

const existing: ExistingSplitLine[] = [
  { id: "s1", categoryId: "food", amount: "-30.0000", tags: [tag("t1")] },
  { id: "s2", categoryId: "home", amount: -20, tags: [tag("t2"), tag("t3")] },
  { id: "s3", categoryId: "food", amount: -10, tags: [] },
];

describe("carrySplitTags", () => {
  it("keeps each line's tags when the same lines are resent", () => {
    expect(
      carrySplitTags(existing, [
        { categoryId: "food", amount: -30 },
        { categoryId: "home", amount: -20 },
        { categoryId: "food", amount: -10 },
      ]),
    ).toEqual([
      { tagIds: ["t1"], tagNames: ["Tag t1"] },
      { tagIds: ["t2", "t3"], tagNames: ["Tag t2", "Tag t3"] },
      null,
    ]);
  });

  it("matches an exact category and amount before a category alone", () => {
    // The -10 food line is listed first; it must not take the -30 line's tag.
    expect(
      carrySplitTags(existing, [
        { categoryId: "food", amount: -10 },
        { categoryId: "food", amount: -30 },
      ]),
    ).toEqual([null, { tagIds: ["t1"], tagNames: ["Tag t1"] }]);
  });

  it("keeps a line's tags through an amount change in the same category", () => {
    expect(
      carrySplitTags(existing, [
        { categoryId: "home", amount: -25 },
        { categoryId: "food", amount: -25 },
      ]),
    ).toEqual([
      { tagIds: ["t2", "t3"], tagNames: ["Tag t2", "Tag t3"] },
      { tagIds: ["t1"], tagNames: ["Tag t1"] },
    ]);
  });

  it("follows a named splitId across a category change", () => {
    expect(
      carrySplitTags(existing, [
        { categoryId: "travel", amount: -20, splitId: "s2" },
        { categoryId: "food", amount: -30 },
      ]),
    ).toEqual([
      { tagIds: ["t2", "t3"], tagNames: ["Tag t2", "Tag t3"] },
      { tagIds: ["t1"], tagNames: ["Tag t1"] },
    ]);
  });

  it("never copies one line's tags onto two lines", () => {
    expect(
      carrySplitTags(
        [{ id: "s1", categoryId: "food", amount: -30, tags: [tag("t1")] }],
        [
          { categoryId: "food", amount: -15 },
          { categoryId: "food", amount: -15 },
        ],
      ),
    ).toEqual([{ tagIds: ["t1"], tagNames: ["Tag t1"] }, null]);
  });

  it("does not let a category match take a line another line named", () => {
    expect(
      carrySplitTags(existing, [
        { categoryId: "food", amount: -30 },
        { categoryId: "other", amount: -30, splitId: "s1" },
      ]),
    ).toEqual([null, { tagIds: ["t1"], tagNames: ["Tag t1"] }]);
  });

  it("gives a line in a new category no tags", () => {
    expect(
      carrySplitTags(existing, [{ categoryId: "travel", amount: -60 }]),
    ).toEqual([null]);
  });

  it("refuses a splitId that is not a line of this transaction", () => {
    expect(() =>
      carrySplitTags(existing, [
        { categoryId: "food", amount: -30, splitId: "elsewhere" },
      ]),
    ).toThrow(BadRequestException);
  });

  it("refuses a splitId named by two lines", () => {
    expect(() =>
      carrySplitTags(existing, [
        { categoryId: "food", amount: -15, splitId: "s1" },
        { categoryId: "food", amount: -15, splitId: "s1" },
      ]),
    ).toThrow(BadRequestException);
  });
});
