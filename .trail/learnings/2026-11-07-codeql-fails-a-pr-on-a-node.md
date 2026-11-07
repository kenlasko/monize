---
title: CodeQL fails a PR on a hand-escaped RegExp in a spec
author: Node
date: 2026-11-07
branch: claude/issue-2057
cost: { minutes: 2, tokens: 21213 }
touches:
  - backend/src/help/help.service.spec.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
- CodeQL's default setup analyzes spec files, and js/incomplete-sanitization (high) fails the PR's CodeQL check on `str.replace(/\./g, "\\.")` used to build a `new RegExp(...)`: it escapes dots but not backslashes. In a test, compare with `startsWith` / `stringContaining` instead of building a pattern; in source, use the backend's `escapeRegExp`.

## Tried and ruled out
- Guessing the alert from the check name: the check-run annotations at api.github.com/repos/kenlasko/monize/check-runs/<id>/annotations (public, no auth) name the rule and line directly.

## Watch out
- Local Bearer runs do not catch this class; only CodeQL does.
