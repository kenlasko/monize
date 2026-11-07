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

/** One theme's picture: what `GET /help/images/:name` serves, and its size. */
export interface HelpImageVariant {
  /** `<name>` for the dark picture, `<name>.light` for the light one. */
  name: string;
  width: number;
  height: number;
  /** The picture's cache key: changes with each release and whenever its file does. */
  revision: string;
}

/** A picture a page shows, in both themes. */
export interface HelpImage {
  dark: HelpImageVariant;
  /** The light twin; `null` when there is none and the dark one shows in both themes. */
  light: HelpImageVariant | null;
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
  /**
   * The pictures the Markdown names (`images/<name>.png`) that the bundle
   * holds, keyed by `<name>`. One that is absent shows as its caption.
   */
  images: Record<string, HelpImage>;
}

/** One ranked section of `GET /help/search`. */
export interface HelpSearchResult {
  page: string;
  /** The section's heading anchor, or `null` for a page's lead paragraph. */
  section: string | null;
  pageTitle: string;
  /** `''` for a page's lead paragraph. */
  heading: string;
  /** Plain text, about 160 characters, around the first matched word. */
  excerpt: string;
  score: number;
}

/** Response of `GET /help/search`. `total` may exceed `results.length`. */
export interface HelpSearchAnswer {
  results: HelpSearchResult[];
  total: number;
}

/**
 * Same-origin URL of one of the guide's pictures, rendered directly in an
 * `<img>` (the CSP allows images only from the app's own origin). The revision
 * makes the URL change whenever the picture can, so the backend lets the
 * browser keep it until then.
 */
export function helpImageUrl({ name, revision }: HelpImageVariant): string {
  return `/api/v1/help/images/${encodeURIComponent(name)}?v=${encodeURIComponent(revision)}`;
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

  /**
   * Every query is its own request, never cached or deduplicated: each
   * keystroke's answer is distinct, and the caller (`HelpSearchDialog`) is
   * the one that decides which in-flight answer still matters.
   */
  search: async (
    q: string,
    options: { context?: string | null; limit?: number } = {},
  ): Promise<HelpSearchAnswer> => {
    const response = await apiClient.get<HelpSearchAnswer>('/help/search', {
      params: {
        q,
        ...(options.context ? { context: options.context } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      },
    });
    return response.data;
  },
};
