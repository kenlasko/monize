---
title: Bundled-guide file reads clear CodeQL by design but need a reviewed Bearer exception
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-4025168a
scope: repo
status: active
src: agent
touches:
  - scripts/check-bearer-exceptions.mjs
  - backend/src/help/help.service.ts
  - ".github/workflows/ci.yml"
---

## Decided
- The help service reads every guide page once, when the bundle loads, by the slugs the bundled nav.json names; a request only looks its slug up in memory. That fixed CodeQL's path-injection alert outright, because no request value reaches an fs call.
- Bearer still reported the read (CWE-22, CWE-73), because the version CI runs flags any non-literal fs path whatever its source. The owner chose to accept it the way the release-notes reader is accepted: two fingerprints in the CI Bearer exclude list, each with its reason and a review-by date.

## Tried and ruled out
- Reading the page lazily on request after checking the slug's format and looking it up in the nav set: safe, but both CodeQL and Bearer flagged it, since neither can see a lookup guard.
- An inline bearer:disable comment on the read: it works, but nothing ever revisits it; the fingerprint list has a review workflow that opens an issue when an entry is due.

## Watch out
- A fingerprint is md5 of the rule id and the file path plus an instance index, so moving the read to another file, or adding a second fs call before it in the same file, re-reports it under a new id.
- Run scripts/check-bearer-exceptions.mjs after editing the list.

In the code:
- backend/src/help/help.service.ts: readBundle reads all pages; readPage is the single flagged call
- .github/workflows/ci.yml bearer-scan exclude-fingerprint: 693f53c921285bddc3861f6027338c94_0, f4213ea85085fdf7e12b1eb1ee903f75_0 (review-by 2027-02-06)
