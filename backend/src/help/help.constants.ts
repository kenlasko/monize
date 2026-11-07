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

/**
 * The only shape a picture's name may have before it is looked up:
 * `<name>` for the dark picture and `<name>.light` for its light twin, no
 * extension. The lookup in the list read from the bundle is the authority.
 */
export const HELP_IMAGE_NAME_RE = /^[a-z0-9-]+(?:\.light)?$/;

/**
 * A picture a page shows, as the website build reads it: `images/<name>.png`.
 * Global, so for `matchAll` only (which copies it); never `.test` or `.exec`.
 */
export const HELP_IMAGE_REF_RE = /images\/([a-z0-9-]+)\.png/g;
