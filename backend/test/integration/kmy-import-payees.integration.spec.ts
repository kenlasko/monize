import { DataSource } from "typeorm";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import { readKmyFixture } from "@/import/kmy/__fixtures__/kmy-fixtures";
import {
  kmyAccount,
  kmyElement,
  kmyFile,
  kmyPayee,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";
import { createTestCategory, createTestPayee } from "../helpers/test-factories";

describe("kmy import: payee matching and details (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;
  const { runKmy } = h;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  const aliasesOf = async (payee: string): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT pa.alias FROM payee_aliases pa JOIN payees p ON p.id = pa.payee_id
            WHERE p.user_id = $1 AND p.name = $2 ORDER BY pa.alias`,
        [userId, payee],
      )) as { alias: string }[]
    ).map((r) => r.alias);

  const payeeRow = async (name: string) =>
    (
      (await dataSource.query(
        `SELECT p.default_category_id, c.name AS category, p.notes, p.email,
                  p.phone, p.address
             FROM payees p LEFT JOIN categories c ON c.id = p.default_category_id
            WHERE p.user_id = $1 AND p.name = $2`,
        [userId, name],
      )) as {
        default_category_id: string | null;
        category: string | null;
        notes: string | null;
        email: string | null;
        phone: string | null;
        address: string | null;
      }[]
    )[0];

  const warningCodes = (job: ImportJob): string[] =>
    job.result!.warnings.map((w) => w.code);

  /** One file: Checking, a Utilities category and one paid row per payee. */
  const payeeFile = (payees: string[]) =>
    kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000002",
          name: "Utilities",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
        kmyAccount({
          id: "A000003",
          name: "Salary",
          type: 12,
          parentaccount: "AStd::Income",
        }),
      ],
      payees,
      transactions: payees.map((_, index) =>
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "-10/1",
              shares: "-10/1",
              payee: `P${index + 1}`,
            }),
            kmySplit({
              id: "S0002",
              account: "A000002",
              value: "10/1",
              shares: "10/1",
              payee: `P${index + 1}`,
            }),
          ],
          { id: kmyTxId(index + 1), postdate: `2024-01-${10 + index}` },
        ),
      ),
    });

  it("gives City Power its alias and default category and Corner Market none (the section 18 file)", async () => {
    const job = await runKmy(readKmyFixture("syntheticKmy"));

    expect(job.status).toBe("completed");
    expect(await aliasesOf("City Power")).toEqual(["*CITY POWER*"]);
    expect(await aliasesOf("Corner Market")).toEqual([]);
    expect((await payeeRow("City Power")).category).toBe("Electricity");
    expect((await payeeRow("Corner Market")).category).toBeNull();
    expect(job.result).toMatchObject({
      payeeAliasesCreated: 1,
      payeeDefaultCategoriesSet: 1,
      payeeContactDetailsSet: 0,
    });
    expect(warningCodes(job)).toEqual(
      expect.arrayContaining(["payeeMatchingDisabled"]),
    );
    expect(warningCodes(job)).not.toContain("payeeDetailsNotImported");
    // Aliases move no balance: every verification delta is still 0.
    expect(job.result!.verification).toHaveLength(5);
    expect(job.result!.verification.every((v) => v.delta === 0)).toBe(true);
  });

  it("translates what it can, names what it cannot, and writes contact details", async () => {
    const job = await runKmy(
      toKmyBytes(
        payeeFile([
          kmyPayee({
            id: "P1",
            name: "Netflix",
            matchingenabled: 1,
            usingmatchkey: 0,
            matchignorecase: 1,
          }),
          kmyPayee({
            id: "P2",
            name: "Amazon",
            matchingenabled: 1,
            usingmatchkey: 1,
            matchignorecase: 1,
            matchkey: "AMAZON.COM\n^AMZN.*MKTP$\n",
          }),
          kmyPayee({
            id: "P3",
            name: "Gym",
            matchingenabled: 1,
            usingmatchkey: 1,
            matchignorecase: 0,
            matchkey: "^GYM CLUB\n",
          }),
          kmyPayee(
            {
              id: "P4",
              name: "Phone Co",
              notes: "Ask for Sam",
              email: "billing@example.com",
              reference: "CUST-42",
              defaultaccountid: "A000002",
            },
            kmyElement("ADDRESS", {
              street: "1 Main St",
              city: "Springfield",
              state: "IL",
              zip: "62701",
              telephone: "(202) 555-0123",
            }),
          ),
        ]),
        "gzip",
      ),
    );

    expect(job.status).toBe("completed");
    expect(await aliasesOf("Netflix")).toEqual(["*Netflix*"]);
    expect(await aliasesOf("Amazon")).toEqual(["AMZN*MKTP"]);
    expect(await aliasesOf("Gym")).toEqual(["GYM CLUB*"]);
    expect(await payeeRow("Phone Co")).toMatchObject({
      category: "Utilities",
      notes: "Ask for Sam",
      email: "billing@example.com",
      phone: "+12025550123",
      address: "1 Main St, Springfield, IL, 62701",
    });
    const samples = (code: string) =>
      job.result!.warnings.find((w) => w.code === code)?.samples;
    expect(samples("payeeMatchKeyNotImported")).toEqual(["Amazon: AMAZON.COM"]);
    expect(samples("payeeMatchCaseWidened")).toEqual(["Gym: ^GYM CLUB"]);
    expect(samples("payeeDetailsNotImported")).toEqual(["Phone Co"]);
    expect(job.result).toMatchObject({
      payeeAliasesCreated: 3,
      payeeDefaultCategoriesSet: 1,
      payeeContactDetailsSet: 1,
    });
  });

  it("refuses an alias that clashes with the user's own and keeps a payee's own values", async () => {
    const other = await createTestPayee(dataSource, userId, {
      name: "Other Shop",
    });
    await dataSource.query(
      `INSERT INTO payee_aliases (payee_id, user_id, alias) VALUES ($1, $2, '*CITY POWER*')`,
      [other.id, userId],
    );

    const job = await runKmy(readKmyFixture("syntheticKmy"));

    expect(job.status).toBe("completed");
    expect(await aliasesOf("City Power")).toEqual([]);
    expect(await aliasesOf("Other Shop")).toEqual(["*CITY POWER*"]);
    expect(
      job.result!.warnings.find((w) => w.code === "payeeMatchKeyConflict"),
    ).toMatchObject({
      count: 1,
      samples: ["City Power: *CITY POWER*"],
    });
    expect(job.result).toMatchObject({ payeeAliasesCreated: 0 });
  });

  it("keeps an existing payee's own default category and says so", async () => {
    const mine = await createTestCategory(dataSource, userId, {
      name: "Mine",
    });
    await createTestPayee(dataSource, userId, {
      name: "City Power",
      defaultCategoryId: mine.id,
      notes: "my notes",
    });

    const job = await runKmy(readKmyFixture("syntheticKmy"));

    expect(job.status).toBe("completed");
    expect((await payeeRow("City Power")).category).toBe("Mine");
    expect(
      job.result!.warnings.find((w) => w.code === "payeeDetailsKept"),
    ).toMatchObject({ count: 1, samples: ["City Power"] });
    expect(job.result).toMatchObject({ payeeDefaultCategoriesSet: 0 });
    // the alias has no clash, so it is still written
    expect(await aliasesOf("City Power")).toEqual(["*CITY POWER*"]);
  });

  it("writes the same aliases again after a start-fresh wipe", async () => {
    expect((await runKmy(readKmyFixture("syntheticKmy"))).status).toBe(
      "completed",
    );
    // `deleteData` is stubbed: the stub removes the imported rows, not the
    // job and staged rows the running import needs.
    h.stubWipe();
    const second = await runKmy(readKmyFixture("syntheticKmy"), {
      wipeExistingData: true,
    });
    expect(second.status).toBe("completed");
    expect(await aliasesOf("City Power")).toEqual(["*CITY POWER*"]);
    expect(second.result).toMatchObject({ payeeAliasesCreated: 1 });
  });

  it("imports a payee whose name is longer than payees.name, under the cut or the chosen name (issue #2313)", async () => {
    const sepa = `SEPA-LASTSCHRIFT Stadtwerke ${"Mandatsreferenz MR-0042 Glaeubiger-ID DE98ZZZ09999999999 ".repeat(6)}`;
    const bytes = toKmyBytes(
      payeeFile([kmyPayee({ id: "P1", name: sepa })]),
      "gzip",
    );
    const payeeNames = async () =>
      (
        (await dataSource.query(
          `SELECT p.name, t.payee_name FROM transactions t
             JOIN payees p ON p.id = t.payee_id
            WHERE t.user_id = $1`,
          [userId],
        )) as { name: string; payee_name: string }[]
      ).map((row) => [row.name, row.payee_name]);

    const cut = await runKmy(bytes);
    expect(cut.status).toBe("completed");
    const shortened = sepa.trim().slice(0, 255).trimEnd();
    expect(await payeeNames()).toEqual([[shortened, shortened]]);
    // The whole KMyMoney name is not lost: it is the payee's notes.
    expect((await payeeRow(shortened)).notes).toBe(sepa.trim());

    h.stubWipe();
    const renamed = await runKmy(bytes, {
      wipeExistingData: true,
      renames: [{ kind: "payee", handle: 1, name: "Stadtwerke" }],
    });
    expect(renamed.status).toBe("completed");
    expect(await payeeNames()).toEqual([["Stadtwerke", "Stadtwerke"]]);
    expect((await payeeRow("Stadtwerke")).notes).toBe(sepa.trim());
  });
});
