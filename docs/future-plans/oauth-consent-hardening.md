# OAuth consent hardening and Connected Apps

Answers GHSA-vmgq-326p-fprx ("Open OAuth Dynamic Client Registration enables
account-takeover phishing chain"). The task list is
[`oauth-consent-hardening-tasks.md`](./oauth-consent-hardening-tasks.md).

## Assumptions (restated so a fresh session can execute this)

- Dynamic Client Registration stays open with no initial access token and no
  setting to turn it off. MCP clients register themselves; GitHub, Google and
  Slack likewise let anyone create an app and rely on consent. The advisory's
  recommendation 1 is declined for that reason.
- `REGISTRATION_ENABLED` governs Monize user signup only. It does not touch
  `/oauth/reg`, and the phishing victim is an existing signed-in user.
- Already merged before this plan: per-IP caps on the anonymous OIDC routes,
  client expiry and the daily sweep (#2177), new-grant notices (#2179), MCP
  CORS limited to first-party origins. The consent page already showed the
  redirect origin and an unverified-app notice (`2849f4414`).

## What changes

1. **Registration refuses malformed metadata** (`src/oauth/client-identity.ts`,
   the `extraClientMetadata` validator in `oauth-provider.service.ts`). A
   `redirect_uris` entry using plain `http` off a loopback address is refused
   (oidc-provider forces `https` only for implicit-flow web clients). A
   `client_name` carrying control, format or separator characters, blank, over
   100 code points, or presenting itself as Monize is refused. Stored clients
   are never refused after the fact; every surface cleans a stored name with
   `displayClientName`.
2. **The consent heading names who is asking by the destination**
   (`describeRequester`, `consent-template.ts`): "<host> wants access to your
   Monize account", "An application on this device ..." for loopback, the
   scheme for a native app. The self-chosen name becomes a secondary line,
   "It calls itself ...". The page title no longer carries the name.
3. **The new-app notice leads with the destination** (`security-notice.service.ts`,
   `notification-email-copy.ts`, `useNotificationCopy.ts`): a neutral title, a
   message naming the destination, and a target of `/settings#connected-apps`.
   Rows stored before keep their original copy.
4. **Settings > Connected Apps** (`OAuthConnectionsController`,
   `OAuthConnectionsService`, `ConnectedAppsSection`): lists the account's live
   grants with destination, self-chosen name, scopes, connected, last-used and
   end dates, and revokes one without a password change. Storage goes through
   `findGrantsForAccount` / `revokeGrantForAccount` in `postgres.adapter.ts`,
   the fourth access path in `docs/row-level-security-contract.md` section 3.

## What to run and what to observe

- `backend/`: `npm run test:unit -- src/oauth src/notifications/security-notice src/notifications/notification-email-copy`;
  `npm run test:integration -- test/integration/oauth-connected-apps` shows a
  grant of another account neither listed nor revoked.
- `frontend/`: `npm run test -- src/components/settings/ConnectedAppsSection src/hooks/useNotificationCopy`.
- By hand: `POST /oauth/reg` with `redirect_uris: ["http://attacker.test/cb"]`
  answers `invalid_client_metadata`; with `client_name: "Monize Support"` the
  same. A consent link for a client registered as "Google SignIn" with an
  `https://attacker.test` redirect shows "attacker.test wants access to your
  Monize account". After Allow, Settings > Connected Apps lists it and Revoke
  makes its access token fail at `/api/v1/mcp`.

## Rejected alternatives

- **An env var to disable registration**: an admin toggle that breaks MCP for
  every user of the instance to remove a risk consent already addresses.
- **A "Connect a new app" window opened in Settings before consent may be
  granted**: no other OAuth provider works this way; friction on a standard
  flow for a non-standard defence.
- **Client ID Metadata Documents** (`mcp-client-id-metadata-documents.md`): ties
  a name to a domain the registrant controls, which does not stop a phishing
  domain; it stays a separate plan.
