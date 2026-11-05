import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import {
  findQuantitiesNotBonds,
  QuantityNotBonds,
} from "../securities/bond-link.util";
import { loadBondLedger } from "./bond-ledger";
import {
  BondLotsRefusal,
  BondLotsRefusalCode,
  bondLotsFromTransactions,
} from "./bond-lots";
import { BondProgramCache, programOfSecurity } from "./bond-series-resolver";

/**
 * The refusals a write is answerable for: a removal the account cannot cover,
 * with or without a series named. Every other refusal of the lot derivation (a
 * split, a fractional quantity, a row with no series) is reported by the ledger
 * and the valuation, never by blocking an unrelated edit.
 */
const WRITE_REFUSALS: ReadonlySet<BondLotsRefusalCode> = new Set([
  "OVER_REMOVAL",
  "REMOVAL_EXCEEDS_SERIES",
]);

const FALLBACKS: Readonly<
  Record<
    "OVER_REMOVAL" | "REMOVAL_EXCEEDS_SERIES",
    (p: { quantity: string; date: string }) => string
  >
> = {
  OVER_REMOVAL: (p) =>
    `A removal of ${p.quantity} bonds on ${p.date} is larger than the number of bonds the account holds on that date.`,
  REMOVAL_EXCEEDS_SERIES: (p) =>
    `A removal of ${p.quantity} bonds on ${p.date} names a series of which the account holds fewer on that date. Choose a series the account holds, or leave the series empty to take the oldest bonds first.`,
};

/**
 * The HTTP error of a refused lot derivation, its `errorCode` the refusal's own
 * code. A write that would cause the refusal is a 400 (nothing is written); the
 * read of an already unknowable ledger is a 422. The message is translated from
 * the code and the row's raw values; the English text of the refusal is for the
 * logs only.
 */
export function lotsRefusalException(
  refusal: BondLotsRefusal,
  kind: "write" | "read",
): BadRequestException | UnprocessableEntityException {
  const params = {
    code: refusal.code,
    action: refusal.params.action,
    date: refusal.params.date,
    quantity: refusal.params.quantity ?? "",
  };
  const message =
    refusal.code === "OVER_REMOVAL" || refusal.code === "REMOVAL_EXCEEDS_SERIES"
      ? tr(
          `errors.bonds.${refusal.code}`,
          FALLBACKS[refusal.code](params),
          params,
        )
      : tr(
          "errors.bonds.lotsRefused",
          `The bond lots of this security cannot be derived (${params.code}: ${params.action} on ${params.date}). Correct or remove that transaction.`,
          params,
        );
  const body = { message, errorCode: refusal.code };
  return kind === "write"
    ? new BadRequestException(body)
    : new UnprocessableEntityException(body);
}

/**
 * The 400 of a priced trade of a bond-linked security whose price is not a price
 * per bond of its face value (INV-BOND-005): the quantity is not a number of
 * bonds. Nothing is written; `QUANTITY_NOT_BONDS` is its `errorCode`. A trade of
 * a marketable coupon series has the wide band (a cash price up to five times
 * the face value) and its own message.
 */
export function quantityNotBondsException(
  found: QuantityNotBonds,
): BadRequestException {
  const params = { price: found.price, faceValue: found.faceValue };
  const message = found.cashPrice
    ? tr(
        "errors.bonds.QUANTITY_NOT_BONDS_CASH_PRICE",
        `The quantity must be a number of bonds and the price the cash price of one bond of face value ${params.faceValue}; the price ${params.price} is more than five times the face value of one bond.`,
        params,
      )
    : tr(
        "errors.bonds.QUANTITY_NOT_BONDS",
        `The quantity must be a number of bonds and the price a price per bond of face value ${params.faceValue}; the price ${params.price} is not within half to twice the face value of one bond.`,
        params,
      );
  return new BadRequestException({
    message,
    errorCode: "QUANTITY_NOT_BONDS",
  });
}

/**
 * The refusal of the lot derivation over the security's whole ledger right now,
 * null when the lots are derivable, `undefined` when the security is not linked
 * to a bond program (no lots, nothing to guard).
 */
export async function currentLotsRefusal(
  m: EntityManager,
  userId: string,
  securityId: string,
  programCache?: BondProgramCache,
): Promise<BondLotsRefusal | null | undefined> {
  if ((await programOfSecurity(m, userId, securityId, programCache)) === null) {
    return undefined;
  }
  const ledger = await loadBondLedger(m, userId, securityId);
  return bondLotsFromTransactions(ledger.transactions).refusal;
}

/**
 * Refuses, inside the write's own transaction and so before anything commits, a
 * write after which a program-linked security's lots are no longer derivable
 * because a removal is not covered (INV-BOND-007).
 *
 * One helper for every write path of such a security (the UI service, bulk, the
 * AI assistant and MCP through it, the file imports, undo and redo). Usage:
 * `track` the securities the write can touch (old and new) BEFORE it mutates,
 * mutate, then `verify` with the ids of the rows written. The derivation is the
 * one the valuation reads (`bondLotsFromTransactions` over `loadBondLedger`).
 * `verify` throws when the derivation is refused now with a removal refusal and
 * either it was derivable before the write, or the refusal names a written row.
 * A removal problem that already existed and is about some other row does not
 * block an unrelated edit.
 */
export interface BondWriteGuard {
  /** Note the securities a write can touch, before it mutates; each is read once. */
  track(securityIds: Iterable<string | null | undefined>): Promise<void>;
  /** After the mutation: throw when the write made a removal uncovered. */
  verify(writtenRowIds?: Iterable<string>): Promise<void>;
}

/**
 * A guard for ONE write (or one import run): built per call and dropped with
 * it, its state held in the closure, never on the process.
 */
export function createBondWriteGuard(
  m: EntityManager,
  userId: string,
  programCache?: BondProgramCache,
): BondWriteGuard {
  /** Per tracked linked security: its refusal before the write (null: derivable). */
  const before = new Map<string, BondLotsRefusal | null>();
  /** Per tracked linked security: the rows already out of the price band. */
  const outOfBandBefore = new Map<string, ReadonlySet<string>>();
  const seen = new Set<string>();

  return {
    async track(securityIds) {
      for (const id of securityIds) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const refusal = await currentLotsRefusal(m, userId, id, programCache);
        if (refusal === undefined) continue;
        before.set(id, refusal);
        const program = await programOfSecurity(m, userId, id, programCache);
        if (program !== null) {
          const found = await findQuantitiesNotBonds(m, userId, id, program.id);
          outOfBandBefore.set(id, new Set(found.map((f) => f.rowId)));
        }
      }
    },

    async verify(writtenRowIds = []) {
      const written = new Set(writtenRowIds);
      for (const [securityId, offendersBefore] of outOfBandBefore) {
        const program = await programOfSecurity(
          m,
          userId,
          securityId,
          programCache,
        );
        if (program === null) continue;
        const offenders = await findQuantitiesNotBonds(
          m,
          userId,
          securityId,
          program.id,
        );
        const refused = offenders.find(
          (f) => written.has(f.rowId) || !offendersBefore.has(f.rowId),
        );
        if (refused) throw quantityNotBondsException(refused);
      }
      for (const [securityId, refusedBefore] of before) {
        const now = await currentLotsRefusal(
          m,
          userId,
          securityId,
          programCache,
        );
        if (!now || !WRITE_REFUSALS.has(now.code)) continue;
        const namesWrittenRow =
          now.rowId !== undefined && written.has(now.rowId);
        if (refusedBefore === null || namesWrittenRow) {
          throw lotsRefusalException(now, "write");
        }
      }
    },
  };
}

/** Track `securityIds`, ready for the write: `const guard = await beginBondWriteGuard(...)`. */
export async function beginBondWriteGuard(
  m: EntityManager,
  userId: string,
  securityIds: Iterable<string | null | undefined>,
  programCache?: BondProgramCache,
): Promise<BondWriteGuard> {
  const guard = createBondWriteGuard(m, userId, programCache);
  await guard.track(securityIds);
  return guard;
}
