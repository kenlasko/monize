# What's New Phase 2: Interactive Guided Tours

Implementation plan for Phase 2 of GitHub discussion #950. Phase 1 (the release-notes
digest modal) is merged (PR #951). Phase 2 adds guided, in-UI tours of new features:
anchored tooltip overlays that navigate to the relevant screen, highlight the control,
and walk the user through it step by step.

Working branch: `claude/phase-2-implementation-1j82d9`.

## Requirements (from discussion #950)

- Lightweight tooltip overlays walking through highlights in the UI itself: navigate to
  the screen, highlight the control, one sentence of copy, next. No heavy dependency
  (no react-joyride) -- small custom components.
- Optional per-release manifest (route + anchor + i18n key per step); steps with
  missing anchors skip gracefully.
- Tours grouped by app area (transactions, budgets, accounts, ...), individually
  startable from the What's New modal ("Show me").
- Tour copy uses the normal i18n flow (translatable, unlike the English-only notes).
- Maintainer recommendations: expanded tooltips that *lead* the user through a feature
  demonstration (e.g. creating a transaction in a different currency); reusable
  functions; focus on top features; engine repurposable as a New User Introduction.

## Decisions

1. **Hybrid interaction** -- passive steps advance with Next/Back; steps may be marked
   interactive and auto-advance when the user clicks the highlighted element, a target
   appears, or a route change occurs. No form-value tracking.
2. **Scope** -- reusable engine + per-release tours wired into the What's New modal
   + a New User Introduction tour offered via the existing Getting Started card.
3. **Release tours target 1.13.0** (the next release). Content covers features merged
   since v1.12.1; extend the definitions as more features land before release.
4. **Persistence** -- completed/dismissed tours in a `tour_progress` jsonb column on
   `user_preferences`, written via the RLS-compliant `tenantTx` pattern (like
   `backend/src/updates/whats-new.service.ts`). The RLS ratchet forbids new
   `@InjectRepository`/`createQueryRunner` sites.
5. **i18n** -- English-first during development (`en/tours.json` + `npm run
   i18n:pseudo`); the full locale pass is the final commit at acceptance, as Phase 1 did.
6. **Demo mode** -- suppress the auto-offer CTA on the frontend (`demoStore`); manual
   starts and persistence still work (the `DemoModeGuard` only blocks handlers
   decorated `@DemoRestricted`, and these endpoints are not).

## Architecture

### Tour manifests: frontend TypeScript modules

Step copy is next-intl keys, anchors are DOM attributes, routes are frontend routes,
so definitions live in typed frontend modules. The backend persists opaque tour-id
strings only. The What's New modal already receives `currentVersion` from
`GET /updates/whats-new`, so a frontend registry keyed by version answers "which tours
exist for this release" with no backend changes to that endpoint.

Files under `frontend/src/lib/tours/`:

- `types.ts` -- `TourDefinition`, `TourStep`, `TourArea`, `TourAdvance`
- `anchors.ts` -- `TOUR_ANCHORS` const map + `tourAnchor(id)` spread-helper +
  `findTourAnchor(id)`
- `registry.ts` -- `ALL_TOURS`, `getTourById`, `getReleaseTours(version)`, `INTRO_TOUR`
- `definitions/intro.ts`, `definitions/release-1.13.0.ts`
- `positioning.ts` -- pure tooltip-placement math (extracted from `CalendarPopover`'s
  flip/clamp approach)

Key shapes:

```ts
export type TourAdvance =
  | { type: 'next' }                            // passive: Next button
  | { type: 'click' }                           // advance when user clicks the anchor
  | { type: 'appear'; anchorId: TourAnchorId }  // advance when a target appears
  | { type: 'route'; route: string };           // advance on navigation

export interface TourStep {
  id: string;                       // i18n leaf: tours.<i18nPrefix>.steps.<id>.{title,body}
  route: string;                    // engine navigates here if needed
  routeMatch?: string;              // prefix match for dynamic routes (e.g. '/accounts/')
  anchorId: TourAnchorId | null;    // null = centered welcome/outro card
  advance?: TourAdvance;            // default { type: 'next' }
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  skipOnMobile?: boolean;           // filtered at startTour via matchMedia(min-width: 640px)
  anchorTimeoutMs?: number;         // default 5000; timeout => graceful skip
}

export interface TourDefinition {
  id: string;          // persistence key: 'intro/basics', 'release-1.13.0/accounts' -- never rename
  area: TourArea;
  version?: string;    // set for release tours; undefined for evergreen
  i18nPrefix: string;  // e.g. 'intro.basics', 'release.v1_13_0.accounts'
  steps: readonly TourStep[];
}
```

A step whose click triggers navigation must use `advance: { type: 'route' }`, not
`click`. Tour ids are persistence keys and must never be renamed after shipping.

### Engine (frontend)

- `frontend/src/store/tourStore.ts` -- transient Zustand store (modeled on
  `whatsNewStore`): `{ active: { tour, stepIndex, phase }, progress, progressLoaded }`
  with `startTour` / `nextStep` / `prevStep` / `endTour(reason)` / `setPhase` /
  `setProgress`. Phases: `navigating | waiting-anchor | active | missing`. Pure
  advancement logic lives in the store (unit-testable without DOM).
- `frontend/src/components/tours/TourHost.tsx` -- mounted once in `app/layout.tsx`
  beside `WhatsNewHost`. Per-step lifecycle: navigate via `router.push` if needed ->
  `useTourAnchor` waits for the element (MutationObserver + 250 ms poll + timeout) ->
  `scrollIntoView` -> render spotlight + tooltip. Interactive advancement:
  capture-phase click listener on the anchor (`click`), second anchor-wait (`appear`),
  pathname watch (`route`). Missing anchor after timeout: silent skip to next step
  (`logger.debug` only). Dismissal: Esc, End tour button, or unexpected route change ->
  `endTour('dismissed')`. Persistence is optimistic and fire-and-forget
  (`.catch(logger.debug)`). Loads progress once via `GET /updates/tours/progress` when
  authenticated. Note the ESLint rule `react-hooks/set-state-in-effect`: drive state
  through the store and event callbacks, not `setState` in effects.
- Hooks: `frontend/src/hooks/useTourAnchor.ts` (wait-for-element with status) and
  `useAnchorRect.ts` (live `DOMRect` via ResizeObserver + rAF-throttled scroll/resize).
- `frontend/src/components/tours/TourSpotlight.tsx` -- portal, `position: fixed`,
  above `Modal`'s `z-50` backdrop: spotlight `z-[60]`, tooltip `z-[70]`. Four backdrop
  divs around the inflated anchor rect (`bg-black/50`, `transition-all` so the cutout
  animates between steps) + a ring div on the hole. Passive steps add a transparent
  hole-blocker so the page is not clickable mid-explanation; interactive steps omit it
  so only the highlighted element is clickable. Backdrop clicks are inert. Centered
  steps: single full backdrop.
- `frontend/src/components/tours/TourTooltip.tsx` -- anchored card via portal;
  position from pure `computeTooltipPosition(anchorRect, tooltipSize, viewport,
  placement)` (auto = below, flip above, clamp horizontally; measure-after-first-paint
  like `CalendarPopover`). Content from the `tours` namespace: title, one-sentence
  body, "{current} of {total}", Back / Next (or "Try it" hint + "Skip this step" link
  on interactive steps) / Done / End tour. Mobile (< sm): fixed bottom-sheet variant.
  `role="dialog"`, `aria-live="polite"`. Do not reuse `Modal` (its focus trap and
  scroll lock are wrong for a tour); on `appear`-anchored steps inside a form modal,
  leave focus with the form.

### Anchors

Add `{...tourAnchor(TOUR_ANCHORS.x)}` (one line, zero behavior change) to:

- `components/layout/AppHeader.tsx` (+ `MobileNavDrawer.tsx`) -- nav links (nav steps
  `skipOnMobile`)
- `app/transactions/page.tsx` -- New Transaction button
- the transaction form component the New button opens -- form panel + currency field
- `app/accounts/page.tsx` -- Add Account button; dashboard widget grid container
- `components/accounts/shared/ForeignCurrencyFeesSection.tsx` -- section container
- Settings: the `showWhatsNew` toggle row in `PreferencesSection.tsx` and `AppVersion`

Rule (documented in `anchors.ts`): anchor stable containers/buttons, never text nodes;
each id attached in exactly one place.

### Backend (in `backend/src/updates/`)

- Migration `database/migrations/107_user_preferences_tour_progress.sql` (+
  `database/schema.sql`):
  `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS tour_progress JSONB NOT NULL DEFAULT '{}'::jsonb;`
- Entity `user-preference.entity.ts`:
  `@Column({ name: "tour_progress", type: "jsonb", default: {} }) tourProgress`.
  Not added to `UpdatePreferencesDto` (server-managed, like `lastSeenVersion`).
- jsonb shape:
  `{ "<tourId>": { "status": "completed"|"dismissed", "version"?: string, "updatedAt": ISO } }`
- `tours.service.ts` -- all DB access via `tenantTx`: `getProgress(userId)`,
  `saveProgress(userId, tourId, status)` (immutable map merge; missing-row fallback via
  `buildDefaultPreferences`; stamps version on `release-*` ids; caps the map at 200
  keys, pruning oldest), `resetProgress(userId)`.
- `tours.controller.ts` (`@Controller("updates/tours")`, JWT guard):
  `GET /updates/tours/progress`, `POST /updates/tours/progress` (body
  `SaveTourProgressDto`: tourId `@MaxLength(100)` + `@Matches(/^[a-z0-9][a-z0-9./_-]*$/)`,
  status `@IsIn(["completed","dismissed"])`), `DELETE /updates/tours/progress`.
  Register both in `updates.module.ts`.
- Frontend client `frontend/src/lib/tours-api.ts`:
  `toursApi.getProgress/saveProgress/resetProgress`.

### Entry points

1. What's New modal "Show me" -- new `components/whats-new/TourOfferList.tsx` rendered
   by `WhatsNewModal` (new `currentVersion` prop from `WhatsNewHost`) when
   authenticated and `getReleaseTours(currentVersion).length > 0`. Rows: area + tour
   title + "Show me" (completed tours show "Viewed" but stay restartable). Clicking
   closes the modal, then `startTour`. Available in demo mode (manual start).
2. New User Introduction -- "Take the tour" CTA on
   `components/dashboard/GettingStarted.tsx` (the existing `gettingStartedDismissed`
   surface). Hidden in demo mode. Label flips to "Retake the tour" when completed.
3. Settings -- a "Guided tours" row near the `showWhatsNew` toggle in
   `PreferencesSection.tsx` (extract `TourSettingsRow.tsx` if near the line ceiling):
   "Start introduction tour" + "Reset tour progress" (`toursApi.resetProgress()` +
   store clear + toast).

### Shipped tour content

- `intro/basics` (~9 steps, evergreen): centered welcome -> dashboard widget grid ->
  nav (skipOnMobile) -> Accounts add button -> Transactions interactive click on New
  Transaction -> currency field in the opened form -> budgets -> reports ->
  settings/finish.
- `release-1.13.0/accounts` (~3 steps): foreign-currency register on account detail
  (#949). Start on `/accounts` -> interactive route step "open one of your accounts"
  (`advance: { type: 'route' }`, `routeMatch: '/accounts/'`) -> anchor on
  `ForeignCurrencyFeesSection` (gracefully skipped for accounts without
  foreign-currency activity).
- `release-1.13.0/settings` (~3 steps): the What's New feature itself (#951): the
  `showWhatsNew` toggle -> the clickable `AppVersion` label that reopens the notes ->
  done.

Version gating: `getReleaseTours(currentVersion)` matches exactly and `currentVersion`
is 1.12.1 until the release bumps `package.json`, so the "Show me" list stays empty in
dev by default. Verify by bumping the version locally (not committed) or starting tours
directly via the registry in tests; the tours activate automatically once 1.13.0 is cut.

### i18n

Register `"tours"` in `NAMESPACES` (`frontend/src/i18n/messages.ts`); create
`frontend/src/i18n/messages/en/tours.json` with `controls.*`, `offer.*`, `areas.*`,
`intro.basics.*`, `release.v1_13_0.*`. Keep all tour strings in this one namespace to
confine parity churn. English-first; the parity test stays red for other locales until
the acceptance localization commit (same PR, final commit -- exactly as Phase 1 did).

## Agent task list

Execute in order on branch `claude/phase-2-implementation-1j82d9`; commit after each
task; every task must leave its layer's lint + tests green (except the known
parity-test red for untranslated locales after task 6). Update the checkboxes here as
tasks complete.

- [ ] **1. Backend persistence** -- migration 107 + `database/schema.sql` +
  `tourProgress` entity column + `ToursService`/`ToursController`/`SaveTourProgressDto`
  + `updates.module.ts` wiring + `tours.service.spec.ts`/`tours.controller.spec.ts`.
  Copy the `tenantTx`/fallback pattern from `whats-new.service.ts`. Verify:
  `cd backend && npm run lint && npm test`; RLS ratchet stays green.
- [ ] **2. Engine core** -- `lib/tours/types.ts`, `anchors.ts`, `registry.ts` (empty
  definitions acceptable), `positioning.ts`, `store/tourStore.ts`,
  `hooks/useTourAnchor.ts`, `hooks/useAnchorRect.ts`, `lib/tours-api.ts` + unit tests
  (`tourStore`, `positioning`, `useTourAnchor`). Add ResizeObserver/scrollIntoView
  stubs to `test/setup.ts` if absent. Verify: `cd frontend && npm run lint && npm run
  type-check && npm test`.
- [ ] **3. Overlay UI** -- `components/tours/TourSpotlight.tsx`, `TourTooltip.tsx`,
  `TourHost.tsx`, mount `<TourHost />` in `app/layout.tsx` beside `<WhatsNewHost />` +
  component tests (advance, interactive click, graceful skip, Esc, api mock; backdrop
  geometry; hole blocker passive-vs-interactive; controls per step type/position).
- [ ] **4. Anchors + definitions** -- `data-tour-id` instrumentation (list above),
  `definitions/intro.ts`, `definitions/release-1.13.0.ts`, registry entries +
  `registry.test.ts` (version filter, unique ids, every step key exists in
  `en/tours.json`).
- [ ] **5. Entry points** -- `TourOfferList` in `WhatsNewModal` (+ `currentVersion`
  prop through `WhatsNewHost`), Getting Started CTA (demo-suppressed, retake label),
  Settings guided-tours row + updated tests (`WhatsNewModal.test.tsx`,
  `GettingStarted.test.tsx`, `PreferencesSection.test.tsx`).
- [ ] **6. i18n (English + pseudo)** -- complete `en/tours.json`, register the
  namespace, run `npm run i18n:pseudo`. `npm run i18n:check` must pass; the locale
  parity test remains red for untranslated locales by design.
- [ ] **7. E2e happy path** -- `e2e/tests/tours.spec.ts`: Getting Started -> Take the
  tour -> Next -> interactive New Transaction click auto-advances -> finish -> reload
  -> "Retake the tour" (persistence round-trip). Run:
  `cd e2e && npx playwright test tests/tours.spec.ts`.
- [ ] **8. Acceptance localization pass (final commit, at acceptance only)** --
  translate `tours.json` (and any touched catalogs) across all remaining locales +
  pseudo regen; parity tests green.

Manual verification along the way: `docker compose -f docker-compose.dev.yml up`
(migration 107 auto-applies). Fresh user -> Getting Started -> full intro tour
including the interactive New Transaction click; with the version temporarily bumped
to 1.13.0: What's New -> Show me -> accounts and settings mini-tours; Settings ->
reset progress; demo instance -> no auto CTA, manual Show me works.

## Risks / notes

- Focus vs `Modal`: the intro's currency-field step renders while the transaction form
  modal is open -- do not steal focus from the form on `appear`-anchored steps.
- Anchor drift: refactors can detach `data-tour-id`s; graceful-skip degrades rather
  than breaks, and the e2e path guards the intro anchors. Possible follow-up: a test
  asserting each `TOUR_ANCHORS` value has exactly one `tourAnchor(` usage.
- `skipOnMobile` is evaluated at start time; resizing mid-tour does not re-filter
  steps (accepted for v1).
