/** The public documentation site; the backend's counterpart of the frontend's `DOCS_BASE_URL`. */
export const HELP_ONLINE_BASE_URL = "https://www.monize.net/docs";

/** The landing page's slug (`website/docs/index.md`); it is not listed in `nav.json`. */
export const HELP_INDEX_SLUG = "index";

/**
 * The only shape a slug may have before it is looked up. The lookup in the set
 * `nav.json` defines is the authority; this check keeps path-like input from
 * ever reaching it.
 */
export const HELP_SLUG_RE = /^[a-z0-9-]+$/;
