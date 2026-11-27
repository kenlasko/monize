import { describe, expect, it } from 'vitest';
import { splitTotalSigningCategoryId } from './split-rows';

describe('splitTotalSigningCategoryId', () => {
  it("signs the total by the first line's category when it is a category line", () => {
    expect(
      splitTotalSigningCategoryId([
        { splitType: 'category', categoryId: 'cat-food' },
        { splitType: 'transfer', categoryId: 'cat-save' },
      ]),
    ).toBe('cat-food');
  });

  it("never signs it by a transfer line's category (INV-CATEGORY-001)", () => {
    // A transfer line may hold an Income, Expense or Transfer category; it
    // says what the transfer is for, not which way the total runs.
    expect(
      splitTotalSigningCategoryId([
        { splitType: 'transfer', categoryId: 'cat-salary' },
        { splitType: 'category', categoryId: 'cat-food' },
      ]),
    ).toBeUndefined();
  });

  it('has nothing to sign by with no line, or an uncategorized first line', () => {
    expect(splitTotalSigningCategoryId([])).toBeUndefined();
    expect(
      splitTotalSigningCategoryId([{ splitType: 'category', categoryId: undefined }]),
    ).toBeUndefined();
  });
});
