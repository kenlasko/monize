---
title: "Command-line flags in user-facing strings use the short form, because a double hyphen trips the punctuation guard"
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 93, tokens: 118495 }
id: l-849a3b62
scope: repo
status: active
src: agent
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en-GB/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
---

## Decided
The encrypted-KMyMoney-file message names `gpg -d` in the frontend, the backend and the docs. The long flag `gpg --decrypt` fails the frontend punctuation guard, which refuses any new message containing `--`. The guard's baseline is shrink-only, so the string was reworded rather than exempted.

## Tried and ruled out
Switching every layer to `gpg --decrypt` for consistency (translators had flagged the frontend/backend mismatch). It passed i18n:check and the parity specs, and only failed the punctuation spec, which nobody had run for the changed strings.

## Watch out
After changing any English message, run the whole frontend i18n spec directory, not just parity: the punctuation guard is a separate spec. Also, when running backend jest for this feature from a worktree whose path contains the feature's name, a bare pattern matches every file; use a path pattern such as `src/import/kmy`.

In the code: frontend/src/i18n/messages.punctuation.test.ts (BASELINE), import.json `kmyErrors.kmyEncryptedFile`, backend errors.json `import.kmyEncryptedFile`, backend/src/import/kmy/kmy-upload-error.ts.
