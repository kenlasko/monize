---
title: "IMAP weak-DH servers: drop kDHE, do not lower SECLEVEL"
author: Node
date: 2026-11-13
branch: claude/issue-2166
cost: { minutes: 6, tokens: 45495 }
touches:
  - backend/src/email-receipts/imap/imap-mailbox-client.spec.ts
  - backend/src/email-receipts/imap/imap-mailbox-client.ts
---

## Decided
Issue #2166 (Shaw imap.shaw.ca:993 "dh key too small"): the server prefers DHE with a 1024-bit group but also offers RSA and ECDHE suites. `IMAP_TLS_CIPHERS` = `${tls.DEFAULT_CIPHERS}:!kDHE` in imap-mailbox-client.ts makes it negotiate something else. imapflow merges `options.tls` into tls.connect for both implicit TLS and the STARTTLS upgrade.
## Tried and ruled out
`DEFAULT@SECLEVEL=1` works but accepts 1024-bit DH for every server. Adding `!kRSA` would force ECDHE on Shaw, but it could break servers that only offer RSA key exchange, which connected before.
## Watch out
Shaw then picks AES256-GCM-SHA384 with RSA key exchange (no forward secrecy), because the server's own preference order decides. Probe a host with `node -e` and tls.connect({ciphers}) plus getCipher()/getEphemeralKeyInfo().
