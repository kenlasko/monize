import { MnyParserService } from "./mny-parser.service";
import { buildPreview } from "./mny-preview";
import type { KmyFileSummary } from "./model/import-source";
import { readMnyFixture } from "./__fixtures__/mny-fixtures";

describe("buildPreview source-format fields", () => {
  const parsed = new MnyParserService().parse({
    buffer: readMnyFixture("money2002"),
    userDefaultCurrency: "CAD",
    asOf: "2026-07-29",
  });
  const input = {
    stagedFileId: "staged-1",
    filename: "file",
    sizeBytes: 1,
  };
  const kmyFile: KmyFileSummary = {
    container: "gzip",
    fixVersion: 12,
    appVersion: null,
    lastModified: null,
  };

  it("leaves sourceFormat and kmyFile off a Money preview", () => {
    const preview = buildPreview({ ...input, parsed });

    expect(preview).not.toHaveProperty("sourceFormat");
    expect(preview).not.toHaveProperty("kmyFile");
  });

  it("copies sourceFormat and kmyFile when the parsed file carries them", () => {
    const preview = buildPreview({
      ...input,
      parsed: { ...parsed, sourceFormat: "kmy", kmyFile },
    });

    expect(preview.sourceFormat).toBe("kmy");
    expect(preview.kmyFile).toEqual(kmyFile);
  });

  it("counts the payee aliases and default categories only for a KMyMoney file", () => {
    const payees = {
      ...parsed.payees,
      payees: [
        {
          handle: 1,
          name: "A",
          aliases: ["*A*", "A1"],
          defaultCategoryHandle: 3,
        },
        { handle: 2, name: "B", aliases: ["*B*"] },
        { handle: 3, name: "C", defaultCategoryHandle: null },
      ],
    };
    const money = buildPreview({ ...input, parsed: { ...parsed, payees } });
    expect(money.counts).not.toHaveProperty("payeeAliasesToCreate");
    expect(money.counts).not.toHaveProperty("payeeDefaultCategoriesToSet");

    const kmy = buildPreview({
      ...input,
      parsed: { ...parsed, payees, sourceFormat: "kmy", kmyFile },
    });
    expect(kmy.counts.payeeAliasesToCreate).toBe(3);
    expect(kmy.counts.payeeDefaultCategoriesToSet).toBe(1);
  });

  it("takes finalBalance from fileBalances when present, else expectedBalances", () => {
    const key = parsed.accounts.accounts[0].key;
    const fromMapped = buildPreview({ ...input, parsed });
    const fromFile = buildPreview({
      ...input,
      parsed: { ...parsed, fileBalances: new Map([[key, 987.65]]) },
    });

    expect(fromMapped.accounts[0].finalBalance).toBe(
      parsed.expectedBalances.get(key) ?? 0,
    );
    expect(fromFile.accounts[0].finalBalance).toBe(987.65);
  });
});
