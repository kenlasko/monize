# Shared expenses UI consistency tasks

Plan: `docs/future-plans/shared-expenses-ui-consistency.md`.
Specification: `docs/specs/shared-expenses-ui-consistency.md`.

- [x] Read the current review and newly approved screen contract.
- [x] Preserve feature history and merge the current main without conflicts.
- [x] Record the requester-authorized refinement before implementation.
- [x] Implement and test unified split instructions and server amount preview.
- [x] Align summaries, Tabs, filters, forms, attachment header and repayments.
- [x] Correct retained account toggle label and secondary navigation.
- [x] Run focused regressions and the bounded frontend gate.
- [x] Run native browser acceptance and capture real screenshots.
- [x] Finish translations and regenerate pseudo-locales.
- [x] Normal-push, verify the head, and publish new progress/evidence replies.

## 29 October verification ledger

The frontend gate passed lint, type checking, pseudo-locale validation and
1,215 changed test files / 23,524 cases. Documentation and environment checks
passed. An additional seven focused files / 186 cases passed after the final
weight-validation, duplicate-name accessibility and slider-range corrections;
type checking passed again. The broad suite was run once.

The cleared-weight regression failed on the original implementation before the
existing split validator was corrected. Early focused runs also caught outdated
button/caption expectations; an intermediate typecheck caught an unsupported test
option and an unintended bare return in the extracted position caption. These
were corrected. No test, guard, baseline or threshold was disabled or weakened.

Sequential production compile/typecheck/generate and the backend build passed.
All 43 cases in three PostgreSQL suites passed with enforced RLS. The browser
application uses a separate fixture database with RLS off.

All nine Chromium scenarios have passing evidence, with retries disabled:
seven passed initially; the ordinary-save scenario passed after scrolling to the
standard, non-sticky form actions. The unequal split exposed an automatic-preview
arrival during input selection. Disabling the loading field alone did not fix
that race. Initializing its ready input with the received amount, while retaining
a focused/explicit edit, fixed it. The unequal split and six-person trip both
passed afterward. The corresponding delayed-preview/focused-edit regression and
split-editor tests passed (two files / 14 cases), as did focused lint, types and
the rebuilt production output. No further broad suite was run.

Reviewed captures are in
`docs/future-plans/shared-expenses-consistency-screenshots/README.md`.
Verification used one bounded native workload at a time, no Docker and no local
coverage run. The common Modal chrome remains separate upstream work. Publication
is the remaining external step at this commit; its readback is recorded in the
PR/issue thread. Maintainer scope approval, CI and human acceptance remain open.

## 30 October follow-up

- [x] Integrate main's Modal and transaction changes and resolve conflicts.
- [x] Add tab/attachment spacing and full standard top/bottom paging.
- [x] Move review state out of the global banner; preserve explicit review safety.
- [x] Verify focused regressions, lint/types/locales and native DB acceptance.
- [x] Finish browser acceptance.
- [x] Confirm the frontend production build in CI.
- [x] Publish the normal branch update and new evidence replies.

### 30 October verification ledger

Merged main through `6a6a8a01403a11646dfbe48515d19694024e74c7` without
rewriting published history. This includes the common Modal change that was
pending in the preceding ledger. No database migration or locale key changed.

Frontend lint, types, locale validation and changed tests passed: 915 affected
files / 17,136 cases. Backend lint and both type checks passed. The changed
backend run passed 600 of 603 files; the three failing guards found stale deleted
paths in the native verification index and an oversized instruction file. Staging
the rename and shortening the new instruction resolved them: 37 focused cases
passed, with no guard change. An additional 166 backend cases cover replay,
timing-safe comparison, module size and upstream expiry regressions. The final
49 frontend cases cover navigation, pending-filter empty states, pagination and
the upstream month-boundary regression. Environment and documentation checks
passed.

The backend production build and 61 cases in four PostgreSQL suites passed,
including transaction conversion and enforced RLS. Bearer 2.1.3 passed all 84
checks with zero findings using the existing CI exclusions. Replay fingerprint
checks now use the existing timing-safe comparator; no security exception or
threshold changed. The backup exclusion registry was split without changing
its entries.

Local full frontend production compilation reached the 3500 MiB process limit
and was stopped; the limit was not raised. The alternative Webpack attempt was
incompatible with an existing scanner import. The default production build must
therefore be confirmed by CI on the published head. Browser captures in
`docs/future-plans/shared-expenses-final-review-screenshots/README.md` use Next
development mode and the compiled backend, with synthetic data and RLS off;
they are not production-build or RLS evidence.

Chromium ran with one worker and retries disabled. All eleven journeys have
passing evidence: seven initial passes, three focused follow-up passes and the
final ordinary-transaction pass. Initial development-mode route compilation caused
offline fallback/registration timing failures. Anonymous prewarming was found
to redirect protected routes to login; the local harness now prewarms with an
authenticated fixture and asserts the requested URL. An attempted selector
correction was also found to be wrong and reverted; the existing transaction
test and its assertions are unchanged. Authenticated prewarming resolved the
offline route; that run reached the final list assertion before exhausting the
60-second test budget. The final focused local run allows 120 seconds for this
CPU-capped development server, without changing repository or CI timeouts. It
passed in 42.5 seconds, including the persisted bank balance and unchanged group.

All local work used bounded native processes, one heavy command at a time,
with a host-memory reserve and no Docker or local coverage run. The frontend
production build, updated-head CI and formal maintainer acceptance remain
separate gates. No test, guard, baseline or coverage threshold was weakened.

## 30 October navigation and walkthrough follow-up

The published maintainer merge `794b3cb4` passed the full CI pipeline, including
the default frontend production build and bundle check, all four E2E shards,
backend integration tests, Lighthouse and the PR checklist. Discussion #1889
now carries `approved-to-build`. This closes the earlier build/approval blockers;
each subsequent head still needs its own CI result.

Ken's additional review requests Tools-only navigation. WMP also requests a
guided tour for 1.20. The dashboard shortcut is removed, with a regression that
failed on the original component. The new tour reuses the registered tour
engine, offers a phone path and an empty-group exit, and preserves progress for
replay from Settings. It creates no group or financial record: the definition
contains navigation and explanations, and the existing engine saves tour
progress. Existing-transaction handoff remains a separate phase.

Ken's published history is retained. A normal merge through main
`3849eab26a59ac7f9c665b23c75ecf5647e601bb` resolved one adjacent-import conflict
by retaining both shared-expense and reporting-currency imports. There was no
rebase or forced update.

Focused checks passed 639 cases in 22 files, including the merged transaction
form. Browser review exposed the phone sheet covering a group row; anchoring the
list alone was insufficient on a short page. Reusing `computeTooltipPosition`
for the phone sheet lets it flip above a low anchor. Another 104 focused cases
passed, including the sheet, anchor registry and group overview.

All three new Chromium journeys pass with one worker, no retries and the
repository's unchanged timeouts: desktop completion, phone completion and
skipping selection with no group. Completion is checked after navigation reload;
group entries, financial revision and personal accounts are checked through the
API. The initial desktop failure included a 9.4-second development-route response;
an authenticated browser warmup now compiles client routes before the checks.
The local browser uses the development frontend and the existing synthetic
fixture database with RLS off. The merged backend was rebuilt successfully.

The user guide and its reproducible captures live in
`website/docs/shared-expenses.md` and `e2e/docs-screenshots/shared-expenses.spec.ts`.
All 18 full non-English catalogs translate the tour and its owner-view guidance;
regional English catalogs inherit the base, and the pseudo-locale is generated.
The final incremental frontend gate passed lint, types, locale validation and
862 test files / 16,011 cases. `test:changed` used merged baseline `493e980a8`
and included all 37 guard files. Its single broad run took 1,904 seconds under
the retained resource limits, with at least 4,690 MiB of host memory available.
Type checking first caught an unsupported Testing Library option in the new
dashboard test; removing that option retained literal accessible-name matching,
and the corrected type check and the full changed suite passed.

Both backend instruction/documentation guard suites passed all 26 cases.
Repository environment and documentation-manifest checks passed. All three
documentation captures passed; the tour capture was retaken with the standard
notification-prompt dismissal helper so unrelated browser-permission guidance
does not obscure the illustration. Documentation generation completed; its
pending-picture notices concern pre-existing pages outside this change.

The default frontend production build remains an updated-head CI check rather
than another local attempt at exceeding the memory cap. Task-owned app, browser
and database processes were stopped. No Docker, coverage run, guard relaxation
or threshold change was used. Publication and new-head CI are recorded in the
PR and issue replies.

### Documentation refresh on the latest main (31 October local time)

Main advanced to `4e0b85fed` while the frontend gate was running. Its changes
refresh the documentation, add three help links, and introduce paired dark/light
captures. The normal merge preserves the shared-expenses help link and the new
Rules/Taxes links; conflicted HTML is regenerated from the merged Markdown.
No financial implementation changed in this synchronization.

The four pictures now run through `openDocsSession` and `docShot`: dashboard
header, balances, expense dialog and tour. The header capture moved to the
dashboard page's spec, retaining its no-shortcut assertion. Each picture has
a dark and light result. The initial capture command had an over-anchored grep
and discovered no tests; correcting the command discovered the intended batch.
The new dialog capture initially omitted choosing Expense from the Add Expense
menu. After adding that real UI step, both dialog captures and both tour captures
passed in the focused completion run, together with the showcase seed. Both
themes of the header and balances had passed in the preceding run.

The pictures were inspected visually. Lossless recompression was attempted with
decoded-pixel equality checked; the original PNGs were already as small and
were retained. Native browser capture retained the existing resource caps and
more than 4,000 MiB of host memory; all task-owned services stopped afterwards.
The functional desktop/phone/no-group journeys and 16,011-case gate above
belong to `186959466`; this documentation-only synchronization uses focused
verification rather than repeating that broad suite.

Focused synchronization verification passed frontend lint and types, all 58
cases in six documentation/link/E2E-convention/Rules/Taxes test files, the two
backend instruction/documentation guard suites (26 cases), documentation
generation, and both repository environment/documentation checks.
