import type { Report, ReportCategory } from '../report-definitions';

/** One report of the catalogue, with everything the page already worked out for it. */
export interface ReportCatalogueEntry {
  report: Report;
  name: string;
  description: string;
  /** The section's translated name. */
  categoryLabel: string;
  favourite: boolean;
  /** The guided-tour anchor for this report, if a tour points at it. */
  tourAnchor: { 'data-tour-id'?: string };
}

/**
 * What a style's renderer of the reports index is handed. The page keeps the
 * search, the section filter, favourites, the saved-report loads and the
 * handlers; a variant only lays the filtered entries out. `entries` arrive in
 * the page's order (favourites first).
 */
export interface ReportsCatalogueViewProps {
  entries: ReportCatalogueEntry[];
  /** The sections in the order they are offered. */
  categories: readonly ReportCategory[];
  /** Whether the filter shows every section (so a ledger groups by section). */
  groupBySection: boolean;
  categoryLabel: (category: ReportCategory) => string;
  onOpen: (reportId: string) => void;
  onToggleFavourite: (event: React.MouseEvent, report: Report) => void;
}
