---
title: "Test code that escapes XML uses the he library with numeric references, because CI's scanners fail on hand-rolled escapers even in tests"
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 4, tokens: 129545 }
id: l-d8ea9aca
scope: repo
status: active
src: agent
touches:
  - backend/src/import/kmy/__fixtures__/kmy-xml-builders.spec.ts
  - backend/src/import/kmy/__fixtures__/kmy-xml-builders.ts
  - backend/src/import/kmy/map/kmy-payee-match.spec.ts
  - backend/src/import/kmy/reader/kmy-xml-tokenize.spec.ts
  - backend/src/common/escape-html.util.ts
---

## Decided
Bearer and CodeQL scan test files too, and a high finding fails the PR. An escaper written as chained replace calls is flagged by Bearer as manual HTML sanitization (CWE-79); a string replace with a plain-string pattern is flagged by CodeQL as replacing only the first occurrence. Fix the code: encode with `he` (already a backend dependency, behind escapeHtml) and build strings directly instead of single replaces. Do not add the finding to Bearer's ignore list.

## Watch out
For XML, call `encode(value, { decimal: true })`, not escapeHtml: escapeHtml uses named references such as &eacute;, which XML without a DTD rejects. `he` does not encode CR, LF or tab, so attribute values still need those written as character references.

In the code: backend/src/import/kmy/__fixtures__/kmy-xml-builders.ts (escapeAttr), backend/src/common/escape-html.util.ts.
