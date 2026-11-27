import { SplitRow } from '@/components/transactions/SplitEditor';
import { OverrideSplit } from '@/types/scheduled-transaction';

/**
 * Serialize a SplitRow array into the OverrideSplit shape used by both the
 * scheduled-transaction Post and Override APIs. Round-trips the splitKind and
 * embedded investment payload so an investment-kind split survives editing in
 * the post / override dialogs.
 */
export function toOverrideSplits(splits: SplitRow[]): OverrideSplit[] {
  return splits.map((s) => ({
    splitKind: s.splitType,
    // A category line's category, and a transfer line's, of any type, which
    // its linked row holds too (INV-CATEGORY-002); an investment line has none.
    categoryId: s.splitType === 'investment' ? null : (s.categoryId ?? null),
    transferAccountId:
      s.splitType === 'transfer' ? (s.transferAccountId ?? null) : null,
    investment: s.splitType === 'investment' ? s.investment : undefined,
    amount: s.amount,
    memo: s.memo ?? null,
    // Name the source split so the server decides FX provenance by identity and
    // preserves this split's stable id across the edit (issue #1167 F4).
    sourceSplitId: s.sourceSplitId,
    // The FX rate is a deliberate value for the current settlement pair, so the
    // server stamps that pair instead of re-resolving it as an unidentified legacy
    // row (issue #1167 R8-F2/R9-F2): a genuinely new investment line, or a
    // continuing one whose rate the user actually edited (`exchangeRateEdited`).
    rateExplicit:
      s.splitType === 'investment' &&
      (!s.sourceSplitId || s.exchangeRateEdited === true)
        ? true
        : undefined,
  }));
}
