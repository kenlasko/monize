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
      carrySplitTags(
        existing.filter((line) => line.id !== "s3"),
        [
          { categoryId: "home", amount: -25 },
          { categoryId: "food", amount: -25 },
        ],
      ),
    ).toEqual([
      { tagIds: ["t2", "t3"], tagNames: ["Tag t2", "Tag t3"] },
      { tagIds: ["t1"], tagNames: ["Tag t1"] },
    ]);
  });

  it("refuses to guess which same-category line a changed line continues", () => {
    // food -30 carries t1 and food -10 carries none: either could be the -25.
    expect(() =>
      carrySplitTags(existing, [
        { categoryId: "home", amount: -20 },
        { categoryId: "food", amount: -25 },
        { categoryId: "food", amount: -15 },
      ]),
    ).toThrow(BadRequestException);
  });

  it("splits an untagged line in two without asking which continues it", () => {
    expect(
      carrySplitTags(
        [
          { id: "s1", categoryId: "food", amount: -30, tags: [] },
          { id: "s2", categoryId: "home", amount: -20, tags: [] },
        ],
        [
          { categoryId: "food", amount: -10 },
          { categoryId: "food", amount: -20 },
          { categoryId: "home", amount: -20 },
        ],
      ),
    ).toEqual([null, null, null]);
  });

  it("refuses to guess which of two new lines continues a tagged line", () => {
    expect(() =>
      carrySplitTags(
        [
          { id: "s1", categoryId: "food", amount: -30, tags: [tag("t1")] },
          { id: "s2", categoryId: "home", amount: -20, tags: [] },
        ],
        [
          { categoryId: "food", amount: -10 },
          { categoryId: "food", amount: -20 },
          { categoryId: "home", amount: -20 },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  describe("lines of the same category and amount", () => {
    const gifts: ExistingSplitLine[] = [
      {
        id: "a",
        categoryId: "gifts",
        amount: -25,
        memo: "Gift A",
        tags: [tag("t1")],
      },
      {
        id: "b",
        categoryId: "gifts",
        amount: -25,
        memo: "Gift B",
        tags: [tag("t2")],
      },
    ];

    it("tells them apart by memo, in either order", () => {
      expect(
        carrySplitTags(gifts, [
          { categoryId: "gifts", amount: -25, memo: "Gift A" },
          { categoryId: "gifts", amount: -25, memo: "Gift B" },
        ]),
      ).toEqual([
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
        { tagIds: ["t2"], tagNames: ["Tag t2"] },
      ]);
      expect(
        carrySplitTags(gifts, [
          { categoryId: "gifts", amount: -25, memo: "Gift B" },
          { categoryId: "gifts", amount: -25, memo: "Gift A" },
        ]),
      ).toEqual([
        { tagIds: ["t2"], tagNames: ["Tag t2"] },
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
      ]);
    });

    it("refuses when nothing tells them apart and their tags differ", () => {
      expect(() =>
        carrySplitTags(gifts, [
          { categoryId: "gifts", amount: -25, memo: "Gift C" },
          { categoryId: "gifts", amount: -25, memo: "Gift D" },
        ]),
      ).toThrow(BadRequestException);
    });

    it("keeps every set of tags on lines resent identical to each other", () => {
      // Either pairing leaves the same two lines, so there is nothing to guess.
      expect(
        carrySplitTags(gifts, [
          { categoryId: "gifts", amount: -25 },
          { categoryId: "gifts", amount: -25 },
        ]),
      ).toEqual([
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
        { tagIds: ["t2"], tagNames: ["Tag t2"] },
      ]);
    });

    it("follows named splitIds where nothing else tells them apart", () => {
      expect(
        carrySplitTags(gifts, [
          { categoryId: "gifts", amount: -25, splitId: "b" },
          { categoryId: "gifts", amount: -25, splitId: "a" },
        ]),
      ).toEqual([
        { tagIds: ["t2"], tagNames: ["Tag t2"] },
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
      ]);
    });

    it("pairs them in order when they carry the same tags", () => {
      const same = gifts.map((line) => ({ ...line, tags: [tag("t1")] }));
      expect(
        carrySplitTags(same, [
          { categoryId: "gifts", amount: -25, memo: "Gift C" },
          { categoryId: "gifts", amount: -25, memo: "Gift D" },
        ]),
      ).toEqual([
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
        { tagIds: ["t1"], tagNames: ["Tag t1"] },
      ]);
    });

    it("never refuses lines that carry no tags", () => {
      const untagged = gifts.map((line) => ({ ...line, tags: [] }));
      expect(
        carrySplitTags(untagged, [
          { categoryId: "gifts", amount: -20 },
          { categoryId: "gifts", amount: -30 },
        ]),
      ).toEqual([null, null]);
    });
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
