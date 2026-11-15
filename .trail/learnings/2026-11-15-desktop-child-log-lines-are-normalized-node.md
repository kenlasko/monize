---
title: "Desktop child log lines are normalized in the logger, not in the backend"
author: Node
date: 2026-11-15
branch: claude/issue-2227
cost: { minutes: 5, tokens: 79255 }
touches:
  - desktop/README.md
  - desktop/src/child-line.spec.ts
  - desktop/src/child-line.ts
  - desktop/src/logger.spec.ts
  - desktop/src/logger.ts
  - desktop/scripts/smoke-install.ps1
---

## Decided
backend.log readability (issue 2227) is fixed in desktop/src/logger.ts lineSink via desktop/src/child-line.ts: strip ANSI escapes from every child line, and parse the NestJS ConsoleLogger prefix `[Nest] <pid>  - <locale date>  <LEVEL> [<Context>] <msg>` into the record's level plus `[<Context>] <msg>`. The Nest date is Intl-locale formatted (e.g. "11:33:34 p.m."), so it is matched loosely between the pid and the level word.

## Tried and ruled out
Changing the file format away from JSON lines: desktop/scripts/smoke-install.ps1 Assert-RlsEnforced greps backend.log for the JSON-escaped `connected as \"monize_app\"`, and the log viewer's displayLine parses the JSON records. Setting NO_COLOR in composeBackendEnv alone would leave the pid, duplicate date and wrong level (Nest WARN goes to stdout, recorded as info).

## Watch out
Stack-trace lines of a Nest error arrive as separate stderr lines with no prefix; they keep the stream level (warn). test-support/memory-logger.ts does not normalize, by design.
