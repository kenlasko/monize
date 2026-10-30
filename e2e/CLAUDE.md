# E2E Directory

Playwright suite against the full stack. `e2e/ROADMAP.md` is the plan for what to cover next; this file is what every spec follows today.

## Commands

```bash
npm ci && npx playwright install chromium firefox
docker compose -f docker-compose.e2e.yml up -d --wait   # from the repository root; playwright.config.ts also starts it locally
npm test -- --workers=1                                  # the whole suite
npm test -- tests/accounts.spec.ts                       # one file; safe without the flag
npm run test:push                                        # push suite (push/*.spec.ts, playwright.push.config.ts); needs no stack
npm run docs:screenshots                                 # website/docs/images from a demo-data instance; website/README.md "Screenshots"

# the two-replica stack, for tests/cluster.spec.ts (skipped without it)
COMPOSE_PROFILES=cluster E2E_CLUSTER_MODE=multi E2E_INTERNAL_API_URL=http://api-lb \
  docker compose -f docker-compose.e2e.yml up -d --wait
E2E_CLUSTER=multi npx playwright test tests/cluster.spec.ts --project=chromium
```

CI runs every Playwright command inside the official Playwright image, pinned by digest, through `scripts/e2e-playwright.sh` (browsers and their system libraries come with the image; nothing is installed on the runner). The same script works locally: `scripts/e2e-playwright.sh npx playwright test tests/accounts.spec.ts`. When `@playwright/test` changes, update the image as `docs/container-images.md` describes; the script refuses a version mismatch.

`playwright.config.ts` sets one worker only when `CI` is set, and `tests/zz-danger-zone.spec.ts` deletes the shared account, so its `zz-` ordering only means anything serially. The UI locale is pinned to `en` so label-based selectors match the base catalog. `e2e/push/README.md` has the push harness recipe.

## Conventions

- **Seed through the API, test through the UI.** `helpers/api.ts` is a CSRF-aware client over the page's cookie jar; `helpers/factories.ts` POSTs to the real endpoints and returns the created record. A new area gets a new factory, never a click-through setup.
- **One fresh user per test** (`fixtures.ts`: `user`, `api`, `authedPage`). Never share mutable state across tests. Global catalogs (currencies) are shared across users, so generate unique codes and names.
- **Prove persistence.** After acting in the UI, reload and re-assert; optimistic UI lies.
- **Selectors.** Prefer `getByRole('heading' | 'button', { name, exact })` and `getByLabel`; scope list rows by a unique seeded name; `{ exact: true }` for short labels. Never guard with `isVisible()`, which does not auto-wait and silently skips. Scope an alert locator to a region (`page.getByRole('main').getByRole('alert')`): Next mounts a route announcer with `role="alert"` on every page.
- **An API-only login does not authenticate the page.** `authStore` persists only `isAuthenticated` and re-fetches the profile on load; `authedPage` registers through the UI.
- **CSRF cookie values are URL-encoded** (`:` becomes `%3A`); the header value must be `decodeURIComponent`'d.
- **Randomness is `crypto.randomInt(n)`**, never `Math.random()` or a biased `bytes % n`; CodeQL and Bearer both scan this directory.
- **Custom comboboxes** (the transaction payee field) swallow `fill()`; identify a row by a distinctive seeded amount and click a cell that does not stop propagation.
- **Push tests observe only through `push/fixture.ts`.** Never call `deliverPushMessage` or `registration.getNotifications()` from a spec; `frontend/src/test/e2e-conventions.test.ts` scans for both, and for the bare alert locator above.
- **A control renamed or removed in the app has consumers here that no unit suite loads.** Grep this directory for the accessible name in the same commit.
- **A documentation screenshot is a test in `docs-screenshots/` named after its PNG**, taken with `docShot(page, name, element?)` from `docs-screenshots/capture.ts`; never a hand-taken picture.
- **`tests/cluster.spec.ts` runs only against the two-replica stack** and skips itself without `E2E_CLUSTER=multi`; `cluster/api-lb.conf` round-robins with no affinity and labels each answer with `X-E2E-Upstream`. One CI shard starts that stack; the other three are unchanged.
