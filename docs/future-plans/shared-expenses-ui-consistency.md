# Shared expenses UI consistency implementation

Specification: `docs/specs/shared-expenses-ui-consistency.md`.
Tasks: `docs/future-plans/shared-expenses-ui-consistency-tasks.md`.

The existing feature branch contains the group-only first delivery. Preserve
published history, adopt main's approved screen rules and implement the refinement
without reviving private booking. The common Modal chrome landed upstream and is
included by the 30 October merge; shared dialogs retain explicit close actions.

1. Refine the shared split draft/editor using the existing remainder helper and
   server preview. Add regression examples before changing the UI.
2. Update shared overview/detail navigation, summary cards, live filters, toolbar,
   form actions, attachment header and repayment wording. Make only narrow
   reusable-component extensions needed by those screens.
3. Correct the visible label/navigation in the retained managed-account form.
4. Run focused tests, then lint, types, locales, changed tests and the supported
   sequential production build. Run a native browser journey with persisted
   allocations, attachment flow and phone layouts. Check docs and E2E selectors.
5. Translate final copy, regenerate pseudo-locales, commit, normal-push and add
   new progress/evidence replies. Do not rewrite old comments or call the PR ready
   for merge while upstream approval is outstanding.

No Docker. Use the native verification mirror, one heavy process at a time,
3500 MiB memory limit, 1536 MiB available-host reserve, one test worker and limited
CPU. Run the broad gate once; follow failures with focused checks. No coverage
run, guard weakening, dependency change or unrelated cleanup.


## Final review follow-up

Merge current main without rewriting published history. Apply the 30 October
specification to shared pages/tables, the explicit review page and SwipeShell.
Migrate review component tests with the component, retaining identity/error cases.
Update consumer/invariant documentation, run the bounded checks and new browser
layout/paging regressions, then normal-push and post new replies with evidence.
