---
title: "The KMyMoney importer reads XML with the HTML parser already in the backend, and the guard that limits who may import it now lists it"
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 50, tokens: 65325 }
id: l-ab417903
scope: repo
status: active
src: agent
touches:
  - e2e/tests/import-kmy.spec.ts
  - backend/src/email-receipts/imap/imap-source-scan.spec.ts
  - backend/src/import/kmy/map/kmy-map-payees-tags.ts
  - backend/src/import/mny/map/payee-alias-collision.spec.ts
  - backend/src/import/mny/map/payee-alias-collision.ts
  - backend/src/import/mny/writers/write-payee-extras.spec.ts
  - backend/src/import/mny/writers/write-payee-extras.ts
  - backend/src/import/kmy/README.md
  - backend/src/import/kmy/__fixtures__/README.md
  - docs/specs/kmymoney-import.md
---

## Decided
The backend had no XML parser. KMyMoney files are read with htmlparser2 in xmlMode (already a direct dependency), streaming, so no dependency was added. A guard allows htmlparser2 imports in a fixed list of files; Ken approved adding the KMyMoney tokenizer as a third entry.

## Tried and ruled out
- Adding saxes (strict streaming XML parser): works, but a new direct dependency and lockfile change.
- fast-xml-parser (only transitive, via mdb-reader): builds the whole document in memory and has had DOCTYPE entity advisories.
- A hand-written tokenizer: about 300 lines of entity and quoting rules to own.

## Watch out
- htmlparser2 does not enforce well-formedness and expands no DTD entities; the reader checks nesting itself and caps depth. The guard's comment says the Parser is quadratic in nesting depth, so keep the depth cap.
- Adding an entry to that guard list is a reviewed decision; ask the maintainer.

In the code:
- backend/src/import/kmy/reader/kmy-xml-tokenize.ts (the only kmy file importing htmlparser2)
- backend/src/email-receipts/imap/imap-source-scan.spec.ts (the allowed-importers list)
- docs/specs/kmymoney-import.md section 14.1 (alternatives)
