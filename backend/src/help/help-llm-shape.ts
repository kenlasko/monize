import { HELP_INDEX_SLUG, HELP_ONLINE_BASE_URL } from "./help.constants";

/**
 * The `search_help` tool's shape (in-app help plan 6), shared by the
 * assistant's executor and the MCP tool. Everything here goes into a model's
 * context, so every part of it is bounded: the query, the number of sections
 * and each section's text. The guide is text this repository wrote, but to a
 * model it is reference data, never instructions.
 */

/** `search_help`: sections per call, 5 when unasked. */
export const LLM_HELP_DEFAULT_LIMIT = 5;
export const LLM_HELP_MAX_LIMIT = 8;
/** Characters of one section's text a model reads, before the ellipsis. */
export const LLM_HELP_TEXT_MAX_CHARS = 1500;
/** The longest question the tool accepts. */
export const LLM_HELP_QUERY_MAX_CHARS = 200;
/** The guide is written in English; no other language is bundled. */
export const LLM_HELP_LANGUAGE = "en";

/** The `search_help` tool's input, after its schema has validated it. */
export interface LlmHelpQuery {
  query: string;
  limit?: number;
}

/** One section of the guide as a model reads it, and the link to cite. */
export interface LlmHelpSection {
  pageTitle: string;
  /** `''` for a page's lead paragraph, which has no heading. */
  heading: string;
  /** The section on monize.net: `https://www.monize.net/docs/<page>#<anchor>`. */
  url: string;
  /** The section's plain text, at most `LLM_HELP_TEXT_MAX_CHARS` and an ellipsis. */
  text: string;
}

export interface LlmHelpAnswer {
  /** False when this server has no bundled guide; `sections` is then empty. */
  available: boolean;
  /** The running version, which the bundled guide matches. */
  guideVersion: string;
  language: typeof LLM_HELP_LANGUAGE;
  /** Best match first; empty when no section matches. */
  sections: LlmHelpSection[];
}

/** The section's page on the public site, with its anchor when it has one. */
export function helpSectionUrl(page: string, section: string | null): string {
  const pageUrl =
    page === HELP_INDEX_SLUG
      ? `${HELP_ONLINE_BASE_URL}/`
      : `${HELP_ONLINE_BASE_URL}/${page}`;
  return section ? `${pageUrl}#${section}` : pageUrl;
}

/**
 * `text` cut to at most `LLM_HELP_TEXT_MAX_CHARS`, at the last space before
 * the cap when there is one near it, with an ellipsis to say it was cut.
 */
export function capHelpText(text: string): string {
  if (text.length <= LLM_HELP_TEXT_MAX_CHARS) return text;
  const head = text.slice(0, LLM_HELP_TEXT_MAX_CHARS);
  const space = head.lastIndexOf(" ");
  const cut =
    space > LLM_HELP_TEXT_MAX_CHARS - 100 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

/** A requested limit held to 1..`LLM_HELP_MAX_LIMIT`; absent or invalid is the default. */
export function clampHelpLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return LLM_HELP_DEFAULT_LIMIT;
  }
  return Math.min(LLM_HELP_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}
