# Frontend documentation

`frontend/CLAUDE.md` is deliberately short: commands, layout, the handful of rules that apply to every change, and a table sending the reader here. These documents hold the rules themselves, with the reasoning and the defect each one came from. Read the one whose subject the work touches; nobody needs all of them for one change.

| Document | Read it before |
|---|---|
| `api-and-cache.md` | adding an API call, a cached read, a write that moves money, or a component holding asynchronous data |
| `ui-conventions.md` | writing a card, dialog, picker, switcher, row, link or any other control a user interacts with |
| `screens-and-dialogs.md` | adding a page, a dialog or a toolbar: which reference screen to copy and how its controls are arranged |
| `forms-and-formatting.md` | adding an input, formatting a number, date or phone a person reads, or exporting CSV |
| `tables-and-registers.md` | touching a table, a register, row density, a pager or a list toolbar |
| `financial-figures.md` | rendering, deriving or totalling a money figure; scheduled occurrences, loans, portfolio ranges, charts |
| `pwa-push-share.md` | touching push notifications, the service worker, or the Web Share Target |
| `shell-contract.md` | adding code that detects a native shell, changing the push enable controls, or building the Electron or Capacitor shell |
| `testing.md` | writing or changing a test, a mock or a test helper |
| `theming.md` | adding a colour, a palette, a chart or a theme |

Two conventions these documents share:

- **Path conventions.** Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved.
- **A rule that names a guard test is enforced by that test.** The prose explains the rule; the test's failure message points at the offending line. Fix the code, never the baseline -- a baseline in these guards is shrink-only, and converting a file means deleting its line.

When a human points out a defect in code an AI wrote, `AGENTS.md` says what to do: find the existing helper, add a regression test that fails on the original mistake, and write the rule down. The rule goes in the document above whose subject it belongs to, and `frontend/CLAUDE.md` gets at most one line naming the thing to use.
