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
   Release tours are matched on **major.minor**, not the exact version (see Version
   gating below), so they survive patch releases and reach users who skip a version.
4. **Persistence** -- completed/dismissed tours in a `tour_progress` jsonb column on
   `user_preferences`, written via the RLS-compliant `tenantTx` pattern (like
   `backend/src/updates/whats-new.service.ts`). The RLS ratchet forbids new
   `@InjectRepository`/`createQueryRunner` sites.
5. **i18n** -- English-first during development (`en/tours.json` + `npm run
   i18n:pseudo`); the full locale pass is the final commit at acceptance, as Phase 1 did.
6. **Demo mode** -- the backend already suppresses the What's New auto-show for demo
   instances (`WhatsNewService.getWhatsNew`), so the only frontend suppression needed
   is hiding the Getting Started "Take the tour" CTA (`demoStore`) -- do not build a
   second suppression path. Manual starts and persistence still work (the
   `DemoModeGuard` only blocks handlers decorated `@DemoRestricted`, and these
   endpoints are not).

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
  | { type: 'next' }                              // passive: Next button
  | { type: 'click' }                             // advance when user clicks the anchor
  | { type: 'appear'; anchorId: TourAnchorId }    // advance when a target appears
  | { type: 'disappear'; anchorId: TourAnchorId } // advance when a target goes away (e.g. user closes a form)
  | { type: 'route'; route: string };             // advance on navigation

export interface TourStep {
  id: string;                       // i18n leaf: tours.<i18nPrefix>.steps.<id>.{title,body}
  route: string;                    // engine navigates here if needed
  routeMatch?: string;              // prefix match for dynamic routes (e.g. '/accounts/')
  anchorId: TourAnchorId | null;    // null = centered welcome/outro card
  advance?: TourAdvance;            // default { type: 'next' }
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  skipOnMobile?: boolean;           // filtered at startTour via matchMedia(min-width: 640px)
  anchorTimeoutMs?: number;         // default 5000 (10000 for the first anchor after a navigation); timeout => graceful skip
}

export interface TourDefinition {
  id: string;          // persistence key: 'intro/basics', 'release-1.13.0/accounts' -- never rename
  area: TourArea;
  version?: string;    // minor line for release tours ('1.13'); undefined for evergreen
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
  pathname watch (`route`). Missing anchor after timeout: skip to next step
  (`logger.debug` only); the first anchor-wait after a navigation uses a longer
  timeout (`anchorTimeoutMs` default 5000, 10000 post-navigation) so cold route loads
  on slow connections do not eat steps. Track skipped-step count in the store; when
  any steps were skipped, the tour ends on a generic centered "tour finished" card
  instead of vanishing without explanation. Dismissal: Esc, End tour button, or
  unexpected route change -> `endTour('dismissed')`.
  - **Esc precedence vs `Modal`**: `Modal` closes on Escape via a document-level
    keydown (skipped only when focus sits inside a different `role="dialog"`). The
    tour's Esc listener is registered in the **capture phase** and calls
    `stopPropagation()`: while a tour is active, the first Esc ends the tour only;
    a subsequent Esc reaches `Modal` normally. Without this, the currency-field step
    (form modal open, focus in the form) would close the form *and* dismiss the tour
    on one keypress.
  - **Engine-initiated navigation is not "unexpected"**: the store records the route
    it is navigating to (and the target of a pending `route`-advance step, via
    `routeMatch`); only pathname changes matching neither trigger
    `endTour('dismissed')`. `Modal`'s `pushHistory` `pushState` does not change the
    pathname and must not count as a route change.
  - Persistence is optimistic and fire-and-forget (`.catch(logger.debug)`). Loads
    progress once via `GET /updates/tours/progress` when authenticated. Note the
    ESLint rule `react-hooks/set-state-in-effect`: drive state through the store and
    event callbacks, not `setState` in effects.
- Hooks: `frontend/src/hooks/useTourAnchor.ts` (wait-for-element with status) and
  `useAnchorRect.ts` (live `DOMRect` via ResizeObserver + rAF-throttled scroll/resize).
- `frontend/src/components/tours/TourSpotlight.tsx` -- portal, `position: fixed`,
  above `Modal`'s `z-50` backdrop: spotlight `z-[60]`, tooltip `z-[70]`. Four backdrop
  divs around the inflated anchor rect (`bg-black/50`, `transition-all` so the cutout
  animates between steps; the transition and the engine's `scrollIntoView` both
  disable smooth animation under `prefers-reduced-motion`) + a ring div on the hole.
  Passive steps add a transparent
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
  leave focus with the form. **Focus management (keyboard operability)**: on every
  passive step transition, move focus to the tooltip card (`tabIndex={-1}` on the
  container) -- `aria-live` announces content but does not make the controls
  reachable, and `Modal` traps Tab inside itself, so without this the tooltip's
  Next/Back/End buttons are unreachable by keyboard. Focusing the tooltip also makes
  `Modal`'s stacked-dialog check work in our favor (focus inside a different
  `role="dialog"` makes `Modal` ignore Esc/Tab). The only exception is
  `appear`-anchored steps inside a form modal, where focus stays with the form and
  the step advances without tooltip interaction.

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
  `@Column({ name: "tour_progress", type: "jsonb", default: {} }) tourProgress`,
  decorated `@Exclude()` so it does not ride along in `GET` preferences responses
  (the `ClassSerializerInterceptor` is global) -- `GET /updates/tours/progress` is
  the single source of truth. Not added to `UpdatePreferencesDto` (server-managed,
  like `lastSeenVersion`).
- jsonb shape:
  `{ "<tourId>": { "status": "completed"|"dismissed", "version"?: string, "updatedAt": ISO } }`
- `tours.service.ts` -- all DB access via `tenantTx`: `getProgress(userId)`,
  `saveProgress(userId, tourId, status)`, `resetProgress(userId)`. `saveProgress`
  merges **atomically in SQL** rather than read-modify-write in JS -- concurrent
  fire-and-forget saves from multiple tabs must not last-writer-wins the whole map:
  `UPDATE user_preferences SET tour_progress = tour_progress || $1::jsonb WHERE user_id = $2`
  (parameterized, single entry as the right-hand operand; missing-row fallback via
  `buildDefaultPreferences` when the UPDATE affects 0 rows). Stamps version on
  `release-*` ids. A separate best-effort pass inside the same `tenantTx` caps the
  map at 200 keys, pruning oldest by `updatedAt`.
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
   authenticated and there are rows to show. Rows: `getReleaseTours(currentVersion)`,
   plus the intro tour as an extra "New here? Take the introduction tour" row while
   it is neither completed nor dismissed -- most existing users have dismissed the
   Getting Started card (`gettingStartedDismissed`), so without this row the intro
   tour would be discoverable only via Settings. Each row: area + tour title +
   "Show me" (completed tours show "Viewed" but stay restartable). Clicking closes
   the modal, then `startTour`. Available in demo mode (manual start).
2. New User Introduction -- "Take the tour" CTA on
   `components/dashboard/GettingStarted.tsx` (the existing `gettingStartedDismissed`
   surface). Hidden in demo mode. Label flips to "Retake the tour" when completed.
3. Settings -- a "Guided tours" row near the `showWhatsNew` toggle in
   `PreferencesSection.tsx` (extract `TourSettingsRow.tsx` if near the line ceiling):
   "Start introduction tour" + "Reset tour progress" (`toursApi.resetProgress()` +
   store clear + toast).

### Shipped tour content

- `intro/basics` (~10 steps, evergreen): centered welcome -> dashboard widget grid ->
  nav (skipOnMobile) -> Accounts add button -> Transactions interactive click on New
  Transaction -> currency field in the opened form -> centered "close the form to
  continue" step (`advance: { type: 'disappear', anchorId: <form panel> }` -- the
  engine never closes a modal it does not own, and navigating away with the form
  open would collide with `useFormModal`'s history/unsaved-changes handling and
  `Modal`'s scroll lock) -> budgets -> reports -> settings/finish.
- `release-1.13.0/accounts` (~3 steps): foreign-currency register on account detail
  (#949). Start on `/accounts` -> interactive route step whose copy directs the user
  to "open an account with foreign-currency transactions" (`advance: { type:
  'route' }`, `routeMatch: '/accounts/'`) -> anchor on `ForeignCurrencyFeesSection`.
  When the opened account has no foreign-currency activity the anchor never appears;
  instead of ending silently, the tour falls through to a centered outro card that
  describes the feature in a sentence -- a three-step tour must not lose its payoff
  step invisibly.
- `release-1.13.0/settings` (~3 steps): the What's New feature itself (#951): the
  `showWhatsNew` toggle -> the clickable `AppVersion` label that reopens the notes ->
  done.

Version gating: `getReleaseTours(currentVersion)` matches on the **minor line**
(`TourDefinition.version` holds `'1.13'`; the running version is truncated to
major.minor before comparison). Exact matching would make the tours vanish the moment
1.13.1 ships and never reach users who upgrade straight across the minor. Tours stay
offered for the whole 1.13.x line and are **superseded, not carried further**: when
1.14.0 cuts with its own tours, the 1.13 definitions simply stop matching (users who
skip a minor skip its tours -- same policy as the release notes themselves).
`currentVersion` is 1.12.1 until the release bumps `package.json`, so the "Show me"
list stays empty in dev by default. Verify by bumping the version locally (not
committed) or starting tours directly via the registry in tests; the tours activate
automatically once 1.13.0 is cut.

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
  `tourProgress` entity column (`@Exclude()`d from serialization) +
  `ToursService`/`ToursController`/`SaveTourProgressDto`
  + `updates.module.ts` wiring + `tours.service.spec.ts`/`tours.controller.spec.ts`.
  Copy the `tenantTx`/fallback pattern from `whats-new.service.ts`; `saveProgress`
  merges via the atomic `tour_progress || $1::jsonb` UPDATE (see above), not JS
  read-modify-write. Verify: `cd backend && npm run lint && npm test`; RLS ratchet
  stays green.
- [ ] **2. Engine core** -- `lib/tours/types.ts`, `anchors.ts`, `registry.ts` (empty
  definitions acceptable), `positioning.ts`, `store/tourStore.ts`,
  `hooks/useTourAnchor.ts`, `hooks/useAnchorRect.ts`, `lib/tours-api.ts` + unit tests
  (`tourStore`, `positioning`, `useTourAnchor`). Add ResizeObserver/scrollIntoView
  stubs to `test/setup.ts` if absent. Verify: `cd frontend && npm run lint && npm run
  type-check && npm test`.
- [ ] **3. Overlay UI** -- `components/tours/TourSpotlight.tsx`, `TourTooltip.tsx`,
  `TourHost.tsx`, mount `<TourHost />` in `app/layout.tsx` beside `<WhatsNewHost />` +
  component tests (advance, interactive click, graceful skip + skipped-steps outro,
  Esc capture-phase precedence over `Modal`, tooltip receives focus on passive step
  transitions, api mock; backdrop geometry; hole blocker passive-vs-interactive;
  controls per step type/position). Budget for the frontend coverage thresholds (91%
  lines): the observer/timing branches in `TourHost`/`useTourAnchor` need explicit
  tests, not just the happy path.
- [ ] **4. Anchors + definitions** -- `data-tour-id` instrumentation (list above),
  `definitions/intro.ts`, `definitions/release-1.13.0.ts`, registry entries +
  `registry.test.ts` (minor-line version filter, unique ids, every step key exists in
  `en/tours.json`) + an anchor-uniqueness test asserting each `TOUR_ANCHORS` value
  has exactly one `tourAnchor(` usage in `src/` -- anchor drift is the engine's
  biggest long-term failure mode and the test is cheap.
- [ ] **5. Entry points** -- `TourOfferList` in `WhatsNewModal` (+ `currentVersion`
  prop through `WhatsNewHost`; release rows + conditional intro row), Getting Started
  CTA (demo-suppressed, retake label), Settings guided-tours row + updated tests
  (`WhatsNewModal.test.tsx`, `GettingStarted.test.tsx`, `PreferencesSection.test.tsx`).
- [ ] **6. i18n (English + pseudo)** -- complete `en/tours.json`, register the
  namespace, run `npm run i18n:pseudo`. `npm run i18n:check` must pass; the locale
  parity test remains red for untranslated locales by design.
- [ ] **7. E2e happy path** -- `e2e/tests/tours.spec.ts`: Getting Started -> Take the
  tour -> Next -> interactive New Transaction click auto-advances -> close the form
  (the `disappear` step advances) -> finish -> reload -> "Retake the tour"
  (persistence round-trip). Run:
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
  modal is open -- do not steal focus from the form on `appear`-anchored steps. All
  other passive steps DO move focus to the tooltip (see Overlay UI): that is what
  makes the controls keyboard-reachable and what makes `Modal` yield Esc/Tab.
- Esc handling: the tour's capture-phase Esc listener must stop propagation, or one
  keypress during an in-modal step both closes the form and dismisses the tour.
- Anchor drift: refactors can detach `data-tour-id`s; graceful-skip degrades rather
  than breaks, the skipped-steps outro card keeps the degradation visible, the e2e
  path guards the intro anchors, and the task-4 anchor-uniqueness test catches
  detached or double-attached ids at CI time.
- `skipOnMobile` is evaluated at start time; resizing mid-tour does not re-filter
  steps (accepted for v1).
- `routeMatch: '/accounts/'` is a prefix match: any future non-detail subroute under
  `/accounts/` would also satisfy it (today only `[id]` exists -- accepted for v1).
- Migration number 107 is next as of writing; re-check for collisions with in-flight
  PRs before merging.
