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

/** One theme's picture: what `GET /help/images/:name` serves, and its size. */
export interface HelpImageVariant {
  /** `<name>` for the dark picture, `<name>.light` for the light one. */
  name: string;
  width: number;
  height: number;
  /**
   * The picture's cache key, sent back as `?v=`: the running version and the
   * file's own revision, so it changes with every release and whenever the
   * file does (a retaken screenshot in the dev stack's mount).
   */
  revision: string;
}

/** A picture a page shows, in both themes. */
export interface HelpImage {
  dark: HelpImageVariant;
  /** The light twin; `null` when there is none and the dark one shows in both themes. */
  light: HelpImageVariant | null;
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
  /**
   * Every picture the Markdown names (`images/<name>.png`) that the bundle
   * holds, keyed by `<name>`. A picture the bundle lacks is absent, and the
   * page shows its caption instead.
   */
  images: Record<string, HelpImage>;
}

/** A bundled picture's bytes, for `GET /help/images/:name`. */
export interface HelpImageFile {
  data: Buffer;
  contentType: string;
  /** The same cache key the page's `HelpImageVariant` carries. */
  revision: string;
}
