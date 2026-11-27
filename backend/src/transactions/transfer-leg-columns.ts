import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import type { PreparedTransfer } from "./transaction-transfer.service";

/** The column set of each leg of a transfer, as the create writes it. */
export interface TransferLegColumns {
  /** The source leg: `-amount` in the source account's currency, rate 1. */
  readonly from: Partial<Transaction>;
  /** The destination leg: `+toAmount` in its account's currency, at the rate. */
  readonly to: Partial<Transaction>;
}

/**
 * What a transfer's two legs hold, derived once from a `PreparedTransfer`.
 *
 * `writeTransferLegs` creates both rows from this, and the in-place conversion
 * of an existing row (`TransactionConversionService.convertToTransfer`) writes
 * the kept row with its side and creates the other from this same set, so a
 * converted row carries exactly what a created leg would (spec
 * `docs/specs/transaction-transfer-conversion.md`). A second hand-written
 * column list beside the create's is how a converted leg would drift from a
 * created one.
 *
 * Every nullable column is written explicitly (`null`, never `undefined`): on a
 * create the two are the same stored value, and on a conversion the kept row's
 * old value must be replaced, not kept because the key was skipped. The
 * `externalId` is deliberately not here: it names the row that a create wrote
 * and stays on it through a conversion; `writeTransferLegs` adds it to the
 * source leg it creates.
 */
export function transferLegColumns(
  prepared: PreparedTransfer,
): TransferLegColumns {
  const {
    effectiveUserId: userId,
    dto,
    fromOwnerId,
    toOwnerId,
    toAmount,
    sourceCurrency,
    destinationCurrency,
    effectiveExchangeRate,
    fromPayeeName,
    toPayeeName,
  } = prepared;
  const {
    fromAccountId,
    toAccountId,
    transactionDate,
    amount,
    description,
    payeeId,
    referenceNumber,
    status = TransactionStatus.UNRECONCILED,
    categoryId,
  } = dto;

  // Per-user reference data (category, payee link) is written only onto the
  // effective user's own legs; a cross-owner leg carries none of it.
  // One category per transfer: both of the effective user's legs take the
  // same one, of any type (INV-CATEGORY-001, INV-CATEGORY-002).
  const ownReference = (ownerId: string) => ({
    payeeId: ownerId === userId ? payeeId || null : null,
    // category-fit-ok: a column bag; writeTransferLegs and the conversion fit it
    categoryId: ownerId === userId ? categoryId || null : null,
  });

  return {
    from: {
      userId: fromOwnerId,
      accountId: fromAccountId,
      transactionDate: transactionDate as any,
      amount: -amount,
      currencyCode: sourceCurrency,
      exchangeRate: 1,
      description: description || null,
      referenceNumber: referenceNumber ?? null,
      status,
      isTransfer: true,
      payeeName: fromPayeeName,
      ...ownReference(fromOwnerId),
    },
    to: {
      userId: toOwnerId,
      accountId: toAccountId,
      transactionDate: transactionDate as any,
      amount: toAmount,
      currencyCode: destinationCurrency,
      exchangeRate: effectiveExchangeRate,
      description: description || null,
      referenceNumber: referenceNumber ?? null,
      status,
      isTransfer: true,
      payeeName: toPayeeName,
      ...ownReference(toOwnerId),
    },
  };
}
