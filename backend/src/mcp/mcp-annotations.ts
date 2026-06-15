import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shared MCP tool annotations.
 *
 * Annotations are optional hints (per the MCP spec) that help clients reason
 * about a tool before calling it. Every Monize tool operates over the
 * authenticated user's own closed financial dataset, so `openWorldHint` is
 * always `false` (no external/open-world interaction).
 *
 * Pick the constant that matches the tool's effect:
 * - `READ_ONLY`  -- queries/aggregations that never mutate state.
 * - `CREATE`     -- adds a new record (non-idempotent, non-destructive).
 * - `UPDATE`     -- sets fields to given values (idempotent, non-destructive).
 *
 * There is deliberately no "destructive" preset: no MCP tool deletes data. Add
 * one (`destructiveHint: true`) only if a delete/overwrite tool is introduced.
 */

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
