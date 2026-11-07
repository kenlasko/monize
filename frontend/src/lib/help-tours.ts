import { DOCS_LINKS, type DocsLink } from './docs-links';

/**
 * Guide destinations that have a matching guided tour: a tour's last step
 * offers "Read the full guide" here (`TourHost`), and the help panel offers
 * "Show me" on these pages, starting the tour (`HelpPanel`). Keyed by
 * `DocsLink` so a destination has a name, never a help-page slug spelled out
 * twice. `help-tours.test.ts` fails when a tour id here is not in `ALL_TOURS`.
 */
export const HELP_TOURS: Partial<Record<DocsLink, string>> = {
  dashboard: 'intro/basics',
  emailReceipts: 'email-receipts/basics',
};

/**
 * The same mapping, keyed by the help page's slug (what the panel actually
 * has on screen), derived once from `HELP_TOURS` so the two cannot disagree.
 */
const TOUR_BY_HELP_PAGE: Record<string, string> = Object.fromEntries(
  (Object.entries(HELP_TOURS) as Array<[DocsLink, string]>).map(
    ([link, tourId]) => [DOCS_LINKS[link].page || 'index', tourId],
  ),
);

/** The tour id mapped to the guide page currently shown in the panel, if any. */
export function tourIdForHelpPage(page: string): string | undefined {
  return TOUR_BY_HELP_PAGE[page];
}
