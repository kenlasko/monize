import apiClient from './api';
import { dedupe } from './apiCache';

/** One page in the help manifest. */
export interface HelpPageSummary {
  /** File name of the page in `website/docs/` without `.md`; `index` is the landing page. */
  slug: string;
  title: string;
  summary: string;
  /** The `nav.json` group the page sits in; `''` for the landing page. */
  group: string;
}

/** Response of the public `GET /help`. `pages` is in reading order, landing page first. */
export interface HelpManifest {
  version: string;
  /** False when the server has no bundled guide; `pages` is then empty. */
  available: boolean;
  pages: HelpPageSummary[];
}

/** A `##` or `###` section of a page, in document order. */
export interface HelpTocEntry {
  depth: number;
  /** The heading's anchor, as in `docsUrl(...)#<id>`. */
  id: string;
  heading: string;
}

/** Response of the public `GET /help/pages/:slug`. */
export interface HelpPage {
  slug: string;
  title: string;
  group: string;
  /** The page's Markdown as written for the website. */
  markdown: string;
  toc: HelpTocEntry[];
  /** The same page on the public documentation site. */
  onlineUrl: string;
}

// The guide ships inside the backend image, so it cannot change under a running
// page: only a new release does, and that reloads the app.
const HELP_TTL_MS = 30 * 60_000;

/**
 * Client for the bundled user guide. Reads go through `dedupe`, so concurrent
 * callers share one request, and a failure is thrown to every awaiter and never
 * cached: a consumer shows an error state, not an empty page.
 */
export const helpApi = {
  getManifest: (): Promise<HelpManifest> =>
    dedupe(
      'help:manifest',
      async () => {
        const response = await apiClient.get<HelpManifest>('/help');
        return response.data;
      },
      HELP_TTL_MS,
    ),

  getPage: (slug: string): Promise<HelpPage> =>
    dedupe(
      `help:page:${slug}`,
      async () => {
        const response = await apiClient.get<HelpPage>(
          `/help/pages/${encodeURIComponent(slug)}`,
        );
        return response.data;
      },
      HELP_TTL_MS,
    ),
};
