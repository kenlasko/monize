/**
 * The shape the AI tools (`list_tags`, on the assistant and the MCP server)
 * read the user's tags in, and its bounds. A file of its own so the tool
 * schemas can import the bounds without the service.
 */

/** Most tags `getLlmTags` returns in one answer. */
export const LLM_TAGS_MAX_LIMIT = 500;
export const LLM_TAGS_DEFAULT_LIMIT = 100;

/** One of the user's tags as the AI tools (`list_tags`) read it. */
export interface LlmTag {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  /** Uses on non-void transactions dated today or earlier (a transfer counts once). */
  useCount: number;
  /** Date (YYYY-MM-DD) of the latest such use; null when never used. */
  lastUsed: string | null;
}

/** What `getLlmTags` answers: the matching tags, name order, and how many matched. */
export interface LlmTagsResult {
  tags: LlmTag[];
  /** How many tags matched the search, before `limit`. */
  total: number;
  /** True when `limit` cut the list short of `total`. */
  truncated: boolean;
}
