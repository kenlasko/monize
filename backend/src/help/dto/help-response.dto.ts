/** One page in the help manifest. */
export interface HelpPageSummary {
  /** File name of the page in `website/docs/` without `.md`; `index` is the landing page. */
  slug: string;
  title: string;
  summary: string;
  /** The `nav.json` group the page sits in; `""` for the landing page. */
  group: string;
}

/**
 * Response of `GET /help`. `pages` is in reading order, the landing page first,
 * then each `nav.json` group's pages; group by `group` to rebuild the index.
 * When the bundled guide is missing, `available` is false and `pages` is empty.
 */
export interface HelpManifest {
  version: string;
  available: boolean;
  pages: HelpPageSummary[];
}

/** A `##` or `###` section of a page, in document order. */
export interface HelpTocEntry {
  /** Markdown heading level, 2 or 3. */
  depth: number;
  /** The heading's anchor, as in `/docs/<page>#<id>`. */
  id: string;
  heading: string;
}

/** Response of `GET /help/pages/:slug`. */
export interface HelpPage {
  slug: string;
  title: string;
  group: string;
  /** The page's Markdown exactly as written for the website. */
  markdown: string;
  toc: HelpTocEntry[];
  /** The same page (landing page for `index`) on the public documentation site. */
  onlineUrl: string;
}
