# Dashboard hero cycling and daily trivia: task list

The task graph for `docs/future-plans/dashboard-trivia.md`. All of them ship in one PR.

| ID | Task | Depends on | Status |
| --- | --- | --- | --- |
| T1 | `dashboard_trivia` table, RLS policy, backup exclusion and wipe | none | Done |
| T2 | Fact sheet, model sentence validation, daily cron and `GET /ai/trivia` | T1 | Done |
| T3 | Hero `auto` choice, sliding track and pager | none | Done |
| T4 | Trivia line beside the greeting | T2 | Done |
| T5 | Translations | T3, T4 | Done |
| T6 | Retake the dashboard screenshots (`npm run docs:screenshots` in `e2e/`) | T3, T4 | Open |
