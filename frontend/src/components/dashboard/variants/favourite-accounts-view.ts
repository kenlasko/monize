import type { useDragReorder } from '@/hooks/useDragReorder';
import type { InstitutionLogoData } from '@/components/institutions/InstitutionLogo';

/** What a favourite account is worth, as the owner worked it out. */
export type FavouriteAccountValue =
  /** It holds securities whose combined value cannot be worked out. */
  | { known: false }
  | {
      known: true;
      amount: number;
      currencyCode: string;
      /** The account's currency is not the reader's, so `text` names it. */
      foreign: boolean;
      /** Formatted in the account's own currency, the code named when not the reader's. */
      text: string;
      /** "{investments} investments + {cash} cash" for an account holding securities. */
      breakdown: string | null;
    };

/** One favourite account, as every style draws it. */
export interface FavouriteAccountRow {
  id: string;
  /** The account's name, never a linked pair's suffixed ledger name. */
  name: string;
  institution: string | null;
  institutionLogo?: InstitutionLogoData;
  value: FavouriteAccountValue;
  /** Credit cards: the statement days. */
  statementDueDay: number | null;
  statementSettlementDay: number | null;
  /** Open the account (its register, or its detail page). */
  open: () => void;
}

export interface FavouriteAccountsViewProps {
  rows: FavouriteAccountRow[];
  reordering: boolean;
  onToggleReorder: () => void;
  onMove: (index: number, direction: -1 | 1) => void;
  /** The list's drag-to-reorder state (`useDragReorder`), used while reordering. */
  drag: ReturnType<typeof useDragReorder>;
}
