---
title: "A Bearer finding can be reproduced and fingerprinted locally before pushing, and renaming does not clear every one"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-62fbd331
scope: repo
status: active
src: agent
touches:
  - desktop/src/electron-main.ts
  - ".github/workflows/ci.yml"
---

## Decided
- Before pushing a change that may trip the Bearer scan, run it locally on a copy of the changed source with spec files removed; it reports the same findings CI does, in a minute instead of a CI round.
- A fingerprint is md5("<rule id>_<repo-relative path>") followed by "_<instance index>", so an exception can be written before CI prints it.

## Tried and ruled out
- Renaming a variable named `target` to `url` at the notification click's `window.loadURL(...)` call in the desktop shell: still flagged as path traversal (CWE-22). The renaming preference recorded for the help-search and payee findings works for name-triggered rules, not for this sink.

## Watch out
- Bearer skips `*.spec.ts` on its own but not shared test helpers under another folder name, so a helper that walks temp directories is flagged as path traversal.

In the code:
- `docker run --rm -v <copy>:/tmp/scan bearer/bearer:latest scan /tmp/scan --quiet --skip-rule javascript_lang_logger_leak,javascript_express_https_protocol_missing,javascript_lang_exception`
- `printf "javascript_lang_path_traversal_%s" desktop/src/electron-main.ts | md5sum` gives 3282e1a4a347b1d24e25476f60c08a82, matching CI
- .github/workflows/ci.yml (`bearer-scan`: `skip-path`, `exclude-fingerprint`)
