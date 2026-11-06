import { EntityManager, In } from "typeorm";
import { MONEY_SCALE, roundMoney } from "../common/round.util";
import { Transaction } from "../transactions/entities/transaction.entity";
import { EXTERNAL_ID_MAX_LENGTH } from "../transactions/transaction-external-id";

/**
 * An OFX row is stored with the bank's own id for it as its `externalId`, the
 * column an API create keys its retries on (`transaction-external-id.ts`). The
 * OFX specification makes a `FITID` unique per account, so a row whose key the
 * account already holds was imported before, from an earlier download or
 * earlier in the same file, and the import skips it.
 *
 * The prefix keeps the bank's id apart from a key an API client chose for a
 * row of its own. It makes a clash unlikely, not impossible: an API key is free
 * text, and a client could send one that starts with it.
 */
export const OFX_EXTERNAL_ID_PREFIX = "ofx:";

/** How many keys one lookup sends, well inside PostgreSQL's parameter limit. */
const HELD_KEY_LOOKUP_CHUNK = 1000;

/**
 * The `externalId` for a row with this `FITID`, or null when the row has none
 * or its key would not fit the column; such a row imports as it did before the
 * key existed, with no duplicate check of its own.
 */
export function ofxExternalId(fitId: string | null | undefined): string | null {
  const trimmed = fitId?.trim() ?? "";
  if (trimmed === "") return null;
  const key = `${OFX_EXTERNAL_ID_PREFIX}${trimmed}`;
  return key.length <= EXTERNAL_ID_MAX_LENGTH ? key : null;
}

/** The date and amount of the row that holds a bank id in the account. */
export type HeldBankRow = Pick<Transaction, "transactionDate" | "amount">;

/**
 * Whether the row holding a bank id is the file row carrying it: the same date
 * and amount. A row someone edited to another date or amount no longer
 * matches, so a later download of it imports again.
 */
export function isSameBankRow(
  holder: HeldBankRow,
  row: { date: string; amount: number },
): boolean {
  return (
    holder.transactionDate === row.date &&
    roundMoney(Number(holder.amount), MONEY_SCALE) ===
      roundMoney(row.amount, MONEY_SCALE)
  );
}

/** Record that the account now holds `key`, on a row of the line's date and amount. */
export function holdKey(
  held: Map<string, HeldBankRow>,
  key: string,
  row: { date: string; amount: number },
): void {
  held.set(key, { transactionDate: row.date, amount: row.amount });
}

/**
 * The rows of the account already holding a bank id the file carries, keyed by
 * that id, read once before the import writes anything. Keyed as the unique
 * index is, by account alone: the key is the account's, whoever wrote the row
 * that holds it. The import adds each key it writes, so the map stays the
 * account's view for the rest of the file.
 */
export async function loadHeldExternalIds(
  manager: EntityManager,
  accountId: string,
  rows: ReadonlyArray<{ fitId?: string | null }>,
): Promise<Map<string, HeldBankRow>> {
  const keys = [
    ...new Set(
      rows
        .map((row) => ofxExternalId(row.fitId))
        .filter((key): key is string => key !== null),
    ),
  ];
  const held = new Map<string, HeldBankRow>();
  for (let start = 0; start < keys.length; start += HELD_KEY_LOOKUP_CHUNK) {
    const found = await manager.find(Transaction, {
      where: {
        accountId,
        externalId: In(keys.slice(start, start + HELD_KEY_LOOKUP_CHUNK)),
      },
      select: {
        id: true,
        externalId: true,
        transactionDate: true,
        amount: true,
      },
    });
    for (const row of found) {
      if (row.externalId) {
        held.set(row.externalId, {
          transactionDate: row.transactionDate,
          amount: row.amount,
        });
      }
    }
  }
  return held;
}
