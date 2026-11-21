import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  MNY_MAX_OPTION_ITEMS,
  MnyAccountOptionDto,
  MnyImportOptionsDto,
  MnyRenameDto,
} from "./mny-import.dto";

async function overrideResult(currencyOverride: unknown) {
  const dto = plainToInstance(MnyAccountOptionDto, {
    handle: 1,
    include: true,
    currencyOverride,
  });
  const errors = await validate(dto);
  return {
    error: errors.find((e) => e.property === "currencyOverride"),
    value: dto.currencyOverride,
  };
}

describe("MnyAccountOptionDto currencyOverride validation", () => {
  it.each(["q#!", "US", "USDD", "U5D", 123])("rejects %p", async (value) => {
    expect((await overrideResult(value)).error).toBeDefined();
  });

  it.each([null, undefined, ""])("treats %p as no override", async (value) => {
    expect((await overrideResult(value)).error).toBeUndefined();
  });

  it("accepts a code and upper-cases a lower-case one", async () => {
    expect((await overrideResult("CAD")).error).toBeUndefined();
    const lower = await overrideResult("pln");
    expect(lower.error).toBeUndefined();
    expect(lower.value).toBe("PLN");
  });
});

describe("MnyImportOptionsDto array bounds (MIN-4)", () => {
  const errorsFor = async (accounts: number, bills: number) => {
    const dto = plainToInstance(MnyImportOptionsDto, {
      accounts: Array.from({ length: accounts }, (_, handle) => ({
        handle,
        include: true,
      })),
      bills: Array.from({ length: bills }, (_, handle) => handle),
    });
    return (await validate(dto)).map((error) => error.property);
  };

  it("accepts as many accounts and bills as any file holds", async () => {
    expect(await errorsFor(MNY_MAX_OPTION_ITEMS, MNY_MAX_OPTION_ITEMS)).toEqual(
      [],
    );
  });

  it("refuses an array past the bound", async () => {
    expect(await errorsFor(MNY_MAX_OPTION_ITEMS + 1, 0)).toEqual(["accounts"]);
    expect(await errorsFor(0, MNY_MAX_OPTION_ITEMS + 1)).toEqual(["bills"]);
  });
});

describe("MnyRenameDto (issue #2313)", () => {
  const errorsFor = async (rename: Record<string, unknown>) =>
    (await validate(plainToInstance(MnyRenameDto, rename))).map(
      (error) => error.property,
    );

  it("accepts a rename of a known kind within the column", async () => {
    expect(
      await errorsFor({ kind: "payee", handle: 2, name: "x".repeat(255) }),
    ).toEqual([]);
  });

  it("refuses an unknown kind, a handle below 1 and a name past the column", async () => {
    expect(await errorsFor({ kind: "tag", handle: 1, name: "x" })).toEqual([
      "kind",
    ]);
    expect(await errorsFor({ kind: "payee", handle: 0, name: "x" })).toEqual([
      "handle",
    ]);
    expect(
      await errorsFor({ kind: "payee", handle: 1, name: "x".repeat(256) }),
    ).toEqual(["name"]);
  });

  it("bounds the list like the other option arrays", async () => {
    const dto = plainToInstance(MnyImportOptionsDto, {
      renames: Array.from({ length: MNY_MAX_OPTION_ITEMS + 1 }, () => ({
        kind: "payee",
        handle: 1,
        name: "x",
      })),
    });
    expect((await validate(dto)).map((error) => error.property)).toEqual([
      "renames",
    ]);
  });
});
