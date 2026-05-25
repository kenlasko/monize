# E2E Test Roadmap — Phase 2 and Beyond

This document plans the next phases of the Playwright E2E suite. **Phase 1 is
complete** (see status below); the sections after it describe what to build
next, in priority order, and the conventions to carry forward so the suite
stays fast, stable, and honest.

---

## Where Phase 1 landed (status snapshot)

Phase 1 turned a shallow ~34-test smoke suite into a **full CRUD-matrix suite**
for the core money flows and reference data, built on **API/hybrid seeding**.

**Infrastructure (the keystone — reuse it everywhere):**
- `e2e/helpers/api.ts` — CSRF-aware API client over the page's
  `APIRequestContext` (shared cookie jar, so an API call is authenticated as the
  page's user). Handles the double-submit token (decode the `csrf_token` cookie,
  echo it in `X-CSRF-Token`, refresh-and-retry once on 403). Also `uniqueId()`
  and `randomCurrencyCode()` (secure, unbiased — see "Lessons" below).
- `e2e/helpers/factories.ts` — typed factories that POST to the real endpoints
  and return the created record: `createAccount`, `createTransaction`,
  `createScheduledTransaction`, `createCategory`, `createPayee`, `createTag`,
  `createCurrency`.
- `e2e/fixtures.ts` — `user`, `api`, and `authedPage` fixtures. Specs import
  `test`/`expect` from `../fixtures` and get a fresh, isolated user per test.

**Coverage (full CRUD + validation + reload-persistence):**

| Area | Spec | Status |
|------|------|--------|
| Accounts | `accounts.spec.ts` | Full CRUD |
| Transactions | `transactions.spec.ts` | Create / list / edit / delete / validation |
| Bills (scheduled) | `bills.spec.ts` | Full CRUD |
| Reconciliation | `reconciliation.spec.ts` | Setup → reconcile → complete |
| Categories | `categories.spec.ts` | Full CRUD |
| Payees | `payees.spec.ts` | Full CRUD |
| Tags | `tags.spec.ts` | Full CRUD |
| Currencies | `currencies.spec.ts` | Add / edit / deactivate / system-currency guards |
| Import | `import.spec.ts` | Upload → end-to-end QIF import |
| Auth | `auth.spec.ts` | UI black-box (register / login / logout) |

63 tests × {chromium, firefox} = **126**, green in CI with `retries: 2`. The
E2E job now **gates releases** (`build-and-push` lists `e2e-tests` in `needs`).

Phase 1 also uncovered and fixed two real production bugs (currency edit sent
the immutable `code`; Delete was offered for system currencies but no-ops),
each with regression coverage.

**Still on the old smoke-test pattern** (Phase 2 deepens these):
`investments.spec.ts` and `settings.spec.ts` still use bare `{ page }` +
`registerUser` + "page loads / section visible" assertions.

---

## Guiding principles (carry these forward)

1. **API/hybrid seeding is the default.** Seed every precondition via the
   backend API (fast, deterministic, shares the page's cookie jar); reserve UI
   interaction for the exact behavior under test. New areas need new factories —
   add them to `factories.ts`, don't click through setup.
2. **Prove persistence.** After acting in the UI, **reload and re-assert**.
   Optimistic UI lies; a reload proves the write reached the database.
3. **One fresh user per test.** Isolation makes destructive tests safe and the
   suite parallelizable. Never share mutable state across tests.
4. **Selector discipline** (hard-won — see Lessons): prefer
   `getByRole('heading'|'button', { name, exact })` and `getByLabel`; scope list
   rows by a unique seeded name; use `{ exact: true }` for short labels; never
   guard with `isVisible()` (it doesn't auto-wait and silently skips).
5. **Global vs per-user data.** Currencies (and any future global catalog) are
   shared across users — generate unique codes/names so chromium and firefox
   runs can't collide.

### Lessons from Phase 1 (don't relearn these)
- **CSRF cookie encoding:** Express URL-encodes cookie values (`:` → `%3A`); the
  header must be `decodeURIComponent`'d to byte-match the cookie.
- **Auth store rehydration:** `authStore` persists only `isAuthenticated` to
  localStorage and re-fetches the profile on load — so an API-only login does
  **not** make the *page* authenticated. `authedPage` registers via the UI.
- **Secure randomness:** use `crypto.randomInt(n)` for test data. `bytes % n` is
  biased (CodeQL `js/biased-cryptographic-random`) and `Math.random()` is flagged
  by Bearer (CWE-330). Both scanners run on this repo.
- **Custom comboboxes** (e.g. the transaction payee field) swallow `fill()` via a
  `justOpenedRef`; identify rows by a distinctive amount instead, and click a
  cell that doesn't `stopPropagation` to open the edit modal.

---

## Infrastructure to extend (as Phase 2 needs it)

- **New factories** in `factories.ts`: `createSecurity`, `createHolding` /
  `createInvestmentTransaction`, `createBudget`, and report/period seed helpers.
  Payload shapes are authoritative in `frontend/src/lib/*` and
  `backend/src/**/dto/*.ts`.
- **`e2e/fixtures/` files dir** for import formats (CSV/OFX/QFX) — Phase 1 inlines
  a QIF buffer; broaden to real sample files for the other parsers.
- **Multi-user fixtures** (Phase 3): a `secondUser` / `delegatePage` fixture for
  shared-access, delegation, and emergency-access flows (two cookie jars).
- **Admin fixture** (Phase 3): a user promoted to admin (seed via API/DB) for the
  admin surface.

---

## Phase 2 — Wealth & analytics

High value, builds directly on the existing fixtures. Same pattern per area:
create via UI → appears + persists after reload; seed N via API → render; edit;
delete/guards; validation.

### Phase 2 status snapshot (first pass landed)

New factories in `factories.ts`: `createSecurity`, `createInvestmentAccountPair`
(POSTs `accountType: INVESTMENT` + `createInvestmentPair` and returns the linked
`{ cashAccount, brokerageAccount }`), `createInvestmentTransaction`,
`createBudget`, `addBudgetCategory`, `createCustomReport`. 2FA codes are
generated with `otplib` via `helpers/totp.ts`.

| Area | Spec | Landed | Deferred (follow-up) |
|------|------|--------|----------------------|
| Securities | `securities.spec.ts` | Full CRUD + deactivate + validation | — |
| Investments | `investments.spec.ts` | Page chrome; seeded BUY rolls into holdings; reload persistence; UI-driven BUY through the transaction form | Other actions (SELL/DIVIDEND/SPLIT) via UI; price-refresh assertion |
| Budgets | `budgets.spec.ts` | List; detail actuals-vs-budget (seeded category + txn); delete | Wizard-based create + validation (no UI path that isn't the spending-analysis wizard) |
| Reports/insights/net-worth | `reports.spec.ts` | Built-in catalogue; open a report; net-worth + Monte-Carlo report render smokes; dashboard net-worth surface; insights page; seed+open and UI-create a custom report | Custom report builder advanced fields (filters/columns); editing/deleting custom reports; driving the Monte-Carlo projection inputs; asserting exact report figures |
| Error states | `error-states.spec.ts` | Route-intercepted 500s surface a friendly message (tags, securities) -- target endpoints NOT pre-cached by the dashboard | Broader per-page coverage |
| Mobile | `mobile.spec.ts` | Phone-viewport dashboard render + create-account flow | Hamburger-nav navigation; per-flow mobile coverage |
| Settings | `settings.spec.ts` | Sections render; profile-name + default-currency persistence; password change happy + wrong-current + weak-new (incl. re-login) | — |
| 2FA + reset | `security.spec.ts` | 2FA enable (API) reflected in UI, login-with-2FA, disable; forgot-request message; reset missing/invalid-token guards | forgot→reset happy path (infra-blocked, below) |
| Authorization | `authorization.spec.ts` | Unauthenticated visits to every protected route redirect to /login | Cross-user denial (needs the Phase 3 multi-user fixture) |
| Danger zone | `zz-danger-zone.spec.ts` | Account deletion + re-login blocked; named to run **last** (sequential CI), the suite's destructive finale | — |

**Infra blocker for the forgot/reset happy path (2.4):** the e2e stack
configures no SMTP and does not expose the Postgres port to the host, so the raw
reset token (hashed in the DB, only ever emailed) cannot be retrieved by the
runner. It needs either a mail-capture service (e.g. Mailpit) in
`docker-compose.e2e.yml` or an exposed DB/test endpoint. The forgot-request UI
and the invalid-token reset path are covered without it.

**Note on holdings:** `GroupedHoldingsList` seeds its expanded-accounts set from
the first render (empty during load), so account rows render collapsed — expand
the account header before asserting individual holding rows.

### 2.1 Investments & securities (`investments.spec.ts`, new `securities.spec.ts`)
*Current: smoke only.* Routes `/investments`, `/securities`; modules `securities`,
`transactions` (investment txns), `net-worth`.
- Securities CRUD: add a security (symbol/name/type), edit, delete; validation.
- Investment transactions: BUY / SELL / DIVIDEND / fees — seed an investment
  account + security via API, enter a trade in the UI, assert holdings and cost
  basis update; reload to confirm.
- Holdings rebuild: after a sequence of buys/sells, assert quantity and average
  cost; sell-more-than-held guard.
- Price refresh: the refresh button updates prices / portfolio value (mock or
  assert the request fires and the UI reacts).
- Portfolio summary: seeded holdings roll up into the summary totals.

### 2.2 Budgets (`budgets.spec.ts`, new)
*Current: none.* Route `/budgets`; module `budgets`.
- Budget CRUD per category/period; validation (no negative, period required).
- Actuals vs. budget: seed transactions in a category via API, assert the budget
  page shows spent/remaining correctly for the period.
- Rollover / period boundaries: assert current-period scoping is correct.

### 2.3 Reports, insights & net worth (`reports.spec.ts`, new)
*Current: none.* Routes `/reports`, `/insights`, `/dashboard`; modules `reports`,
`built-in-reports`, `monte-carlo`, `net-worth`.
- Built-in reports render with seeded data (spending by category, income vs.
  expense, net worth over time) — assert key figures, not just "renders".
- Custom report builder: create a report definition, run it, edit, delete.
- Net worth: seed accounts with balances; assert the dashboard/net-worth total.
- Monte-carlo projection: drive inputs, assert a projection renders (smoke +
  one numeric sanity check given fixed inputs).

### 2.4 Settings depth & 2FA (`settings.spec.ts` expand, `security.spec.ts` new)
*Current: smoke only.* Routes `/settings`, `/change-password`, `/setup-2fa`,
`/forgot-password`, `/reset-password`; modules `users`, `auth`.
- Profile & preferences: change name/locale/default currency → persists after
  reload and is reflected elsewhere (e.g. currency formatting).
- Password change: happy path + wrong-current-password + weak-new-password
  validation; confirm re-login works with the new password.
- 2FA (TOTP): enable via `/setup-2fa` (generate a TOTP from the seed in test),
  verify the login-with-2FA flow, then disable. `FORCE_2FA=false` in
  `docker-compose.e2e.yml`, so this is opt-in per test.
- Danger zone: account deletion guard/confirmation (use a disposable user).
- Forgot/reset password: request → token → reset (assert the token path; email
  is stubbed in the e2e stack).

---

## Phase 3 — Multi-user, admin & integrations

Needs the multi-user / admin fixtures above. Higher setup cost, lower change
frequency, so it follows Phase 2.

### 3.1 Shared access & delegation (`delegation.spec.ts`, new)
Module `delegation`. Two users via a `secondUser` fixture: owner grants a
delegate access (role/scope), delegate sees only permitted data, owner revokes →
access disappears. Assert authorization boundaries (a delegate cannot exceed its
scope).

### 3.2 Emergency access (`emergency-access.spec.ts`, new)
Module `emergency-access`. Grant emergency contact → request access → waiting
period / approval → access granted; owner can deny/cancel. Assert the state
machine transitions and the access window.

### 3.3 Admin (`admin.spec.ts`, new)
Module `admin`; needs the admin fixture. User management (list/disable/role),
system settings, and any global toggles. Assert non-admins get 403/redirect.

### 3.4 Backup & restore (`backup.spec.ts`, new)
Module `backup`. Export a backup, then restore into a fresh user and assert data
round-trips. Guard against restoring into a non-empty account if that's the
product rule.

### 3.5 Audit / action history & notifications
Modules `action-history`, `notifications`. Assert that mutating actions produce
audit entries; notification preferences persist and the right events surface.

### 3.6 AI assistant & MCP (`ai.spec.ts`, new)
Route `/ai`; modules `ai`, `mcp`. **Stub the LLM provider** (no live API calls in
CI). Assert: a query routes to the right tool and renders a grounded answer with
sources; per CLAUDE.md every AI tool is shared between the assistant and the MCP
server, so cover the assistant surface and trust the backend unit tests for MCP
parity. Verify API keys are never echoed to the client.

### 3.7 OIDC / OAuth (`oidc.spec.ts`, new)
Modules `oauth`, `auth`. Stand up a mock OIDC provider in the e2e compose stack;
drive login via OIDC, link/unlink, and assert local-auth toggles
(`LOCAL_AUTH_ENABLED`, `REGISTRATION_ENABLED`) behave. This is the most
infra-heavy item — schedule last.

---

## Cross-cutting (fold in opportunistically)

- **Authorization matrix:** for each protected route, assert an unauthenticated
  request redirects to `/login` and a cross-user request is denied (defense in
  depth on top of backend tests).
- **Responsive/mobile:** the nav has hidden responsive buttons that bit us in
  Phase 1 — add a small mobile-viewport pass for the primary flows.
- **Accessibility:** consider an `axe` smoke check on key pages.
- **Error states:** assert friendly handling of API failures (seed a 500 via
  route interception) rather than only happy paths.

---

## Definition of done (per area)

- Create / list / edit / delete / validation, each asserting **persistence after
  reload**.
- Preconditions seeded via API factories; UI used only for the flow under test.
- Authorization guard covered (unauth + cross-user where applicable).
- Green on **both** chromium and firefox under `retries: 2`.
- New factories/fixtures documented inline; payload shapes traced to
  `frontend/src/lib/*` and backend DTOs.

## Scaling the runner

Per-test unique users make parallelism safe. As the suite grows, raise
`workers` in `playwright.config.ts` (currently 1 in CI) and consider sharding
across CI runners. Keep `fullyParallel` honest — verify no test depends on the
seeded global catalog ordering before flipping it on.
