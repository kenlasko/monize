/**
 * The authorization-scope vocabulary, defined once.
 *
 * It had four copies: the `personal_access_tokens.scopes` comment in
 * `schema.sql`, the regex in `CreatePatDto`, the `monize:`-prefixed list the
 * OAuth provider advertises, and prose in a feature plan. The schema comment and
 * the plan named a `reports` scope no issuance path had ever accepted, so a
 * client reading either was told about a scope `POST /auth/pats` rejects. A
 * vocabulary spread across four files drifts silently; derive from here instead
 * of restating.
 *
 * `read` and `write` are the whole set. A PAT presents them bare; an OAuth client
 * presents them resource-prefixed (`monize:read`) and `OAuthProviderService`
 * strips the prefix, so both surfaces reach `requireScope`
 * with the same strings. Adding a scope means adding it here and to
 * `frontend/src/components/settings/ApiAccessSection.tsx`; `scopes.spec.ts`
 * checks that every consumer in this repository agrees.
 */
export const API_SCOPES = ["read", "write"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** The resource-indicator prefix OAuth clients use for these scopes. */
export const MCP_SCOPE_PREFIX = "monize:";

/**
 * Matches a non-empty comma-separated list of supported scopes.
 *
 * Built from `API_SCOPES` rather than written out, so a new scope cannot be
 * declared and then rejected by validation -- which is the exact shape of the
 * `reports` defect.
 */
export function apiScopesPattern(): RegExp {
  const one = `(${API_SCOPES.join("|")})`;
  return new RegExp(`^${one}(,${one})*$`);
}

/** Human-readable list for validation messages and API documentation. */
export function apiScopesList(): string {
  return API_SCOPES.join(", ");
}

/** True when `scope` is part of the supported vocabulary. */
export function isApiScope(scope: string): scope is ApiScope {
  return (API_SCOPES as readonly string[]).includes(scope);
}

/**
 * True when a stored comma-separated scope list holds `required`.
 *
 * Exact membership, on every surface: `write` does not imply `read`, so a
 * token meant to do both carries both. The MCP transport and the REST
 * `PatAccessGuard` both answer from here.
 */
export function hasApiScope(scopes: string, required: string): boolean {
  return scopes.split(",").includes(required);
}
