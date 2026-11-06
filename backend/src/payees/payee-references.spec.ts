import { readFileSync } from "fs";
import { join } from "path";
import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { EmailReceiptParser } from "../email-receipts/entities/email-receipt-parser.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Warranty } from "../warranties/entities/warranty.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import {
  PAYEE_REFERENCE_MOVES,
  reassignPayeeReferences,
} from "./payee-references";

/**
 * Proves a payee merge moves every row that points at the payee it deletes.
 *
 * Both merges (the Merge dialog and Auto-Merge) used to move transactions,
 * scheduled transactions and aliases and nothing else, so deleting the source
 * payee let `ON DELETE SET NULL` clear its warranties, email receipt parsers,
 * loan overpayment links and shared-expense people (#2026). The list of what to
 * move is now `PAYEE_REFERENCE_MOVES`; what is left to go wrong is a migration
 * adding a reference and not extending it, so that is checked here against the
 * schema rather than against a list somebody has to remember to update.
 */

const SCHEMA_PATH = join(__dirname, "..", "..", "..", "database", "schema.sql");

/** Schema text with `--` comments blanked, so documentation cannot match. */
const uncommented = readFileSync(SCHEMA_PATH, "utf8")
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/** Every `table.column` with a foreign key to `payees(id)`. */
function parsePayeeReferences(sql: string): string[] {
  const references: string[] = [];
  const target = String.raw`REFERENCES\s+payees\s*\(\s*id\s*\)`;
  const tableBlocks = sql.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g,
  );
  for (const [, table, body] of tableBlocks) {
    for (const match of body.matchAll(
      new RegExp(String.raw`^\s*(\w+)\s+[A-Za-z0-9_() ,]*?${target}`, "gim"),
    )) {
      references.push(`${table}.${match[1]}`);
    }
    for (const match of body.matchAll(
      new RegExp(String.raw`FOREIGN KEY\s*\((\w+)\)\s*${target}`, "gi"),
    )) {
      references.push(`${table}.${match[1]}`);
    }
  }
  for (const match of sql.matchAll(
    new RegExp(
      String.raw`ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ADD CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\((\w+)\)\s*${target}`,
      "gi",
    ),
  )) {
    references.push(`${match[1]}.${match[2]}`);
  }
  return references.sort();
}

describe("PAYEE_REFERENCE_MOVES", () => {
  const schemaReferences = parsePayeeReferences(uncommented);
  const moved = Object.keys(PAYEE_REFERENCE_MOVES).sort();

  it("finds the references the schema is known to declare", () => {
    // A parser that matched nothing would pass both directions below vacuously.
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "transactions.payee_id",
        "warranties.payee_id",
        "accounts.overpayment_payee_id",
      ]),
    );
  });

  it("moves every foreign key to payees(id) the schema declares", () => {
    const missing = schemaReferences.filter((ref) => !moved.includes(ref));
    expect(missing).toEqual([]);
  });

  it("names no column the schema does not reference payees from", () => {
    const stale = moved.filter((ref) => !schemaReferences.includes(ref));
    expect(stale).toEqual([]);
  });
});

describe("reassignPayeeReferences", () => {
  const userId = "user-1";
  const reassignment = {
    userId,
    sourcePayeeId: "source",
    target: { id: "target", name: "Costco" },
  };

  function makeManager() {
    return {
      update: jest.fn().mockResolvedValue({ affected: 2 }),
      query: jest.fn().mockResolvedValue([[], 1]),
    };
  }

  it("points every reference at the target, scoped to the user", async () => {
    const m = makeManager();

    const result = await reassignPayeeReferences(
      m as unknown as EntityManager,
      reassignment,
    );

    expect(m.update).toHaveBeenCalledWith(
      Transaction,
      { payeeId: "source", userId },
      { payeeId: "target", payeeName: "Costco" },
    );
    expect(m.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      { payeeId: "source", userId },
      { payeeId: "target", payeeName: "Costco" },
    );
    expect(m.update).toHaveBeenCalledWith(
      PayeeAlias,
      { payeeId: "source", userId },
      { payeeId: "target" },
    );
    expect(m.update).toHaveBeenCalledWith(
      Warranty,
      { payeeId: "source", userId },
      { payeeId: "target" },
    );
    expect(m.update).toHaveBeenCalledWith(
      EmailReceiptParser,
      { payeeId: "source", userId },
      { payeeId: "target", revision: expect.any(Function) },
    );
    expect(m.update).toHaveBeenCalledWith(
      Account,
      { overpaymentPayeeId: "source", userId },
      { overpaymentPayeeId: "target" },
    );
    for (const table of ["shared_people", "shared_postings"]) {
      expect(m.query).toHaveBeenCalledWith(
        `UPDATE ${table} SET payee_id = $1 WHERE user_id = $2 AND payee_id = $3`,
        ["target", userId, "source"],
      );
    }
    expect(Object.keys(result).sort()).toEqual(
      Object.keys(PAYEE_REFERENCE_MOVES).sort(),
    );
    expect(result["transactions.payee_id"]).toBe(2);
    expect(result["shared_people.payee_id"]).toBe(1);
  });

  it("bumps a moved receipt parser's revision so a stale edit is refused", async () => {
    const m = makeManager();

    await reassignPayeeReferences(m as unknown as EntityManager, reassignment);

    const parserCall = m.update.mock.calls.find(
      ([entity]) => entity === EmailReceiptParser,
    );
    expect(parserCall?.[2].revision()).toBe("revision + 1");
  });

  it("reports zero for a reference whose update affected nothing", async () => {
    const m = makeManager();
    m.update.mockResolvedValue({});

    const result = await reassignPayeeReferences(
      m as unknown as EntityManager,
      reassignment,
    );

    expect(result["transactions.payee_id"]).toBe(0);
  });
});
