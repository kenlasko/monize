# OAuth consent hardening: Agent Task List

> Companion to [`oauth-consent-hardening.md`](./oauth-consent-hardening.md) (the design). One PR; each task is one commit.

## Definition of done for every task

- `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:changed`; `npm run build && npm run test:integration` for T4.
- `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`.
- New user-facing strings: English catalogs, then `npm run i18n:pseudo`; every other locale in T6.
- Stage new files before running a guard (`git add -N` is enough).

## Tasks

| ID | Task | Files | Status |
|----|------|-------|--------|
| T1 | Registration refuses plain-http redirects off loopback and deceptive client names | `backend/src/oauth/client-identity.ts`, `oauth-provider.service.ts` and specs | [x] |
| T2 | Consent heading names the destination; name demoted to "It calls itself" | `backend/src/oauth/redirect-target.ts`, `consent-template.ts`, `en/common.json` | [x] |
| T3 | New-app notice leads with the destination and targets Connected Apps | `backend/src/notifications/security-notice.service.ts`, `notification-email-copy.ts`, `frontend/src/hooks/useNotificationCopy.ts` | [x] |
| T4 | Connected Apps API: list and revoke one grant | `backend/src/oauth/postgres.adapter.ts`, `oauth-connections.*`, `parse-oauth-grant-id.pipe.ts`, `test/integration/oauth-connected-apps.integration.spec.ts`, `docs/row-level-security-contract.md` | [x] |
| T5 | Settings > Connected Apps section, docs page and screenshot | `frontend/src/components/settings/ConnectedAppsSection.tsx`, `frontend/src/lib/oauth-connections.ts`, `website/docs/*.md`, `e2e/docs-screenshots/settings-and-security.spec.ts` | [x] |
| T6 | Translate every locale | `backend/src/i18n/locales/*`, `frontend/src/i18n/messages/*` | [x] |
