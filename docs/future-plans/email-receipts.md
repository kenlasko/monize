# Email receipts: order-confirmation emails enrich bank transactions

Companion files: [`email-receipts-tasks.md`](./email-receipts-tasks.md) (the
task list) and `docs/specs/email-receipt-matching.md` (the
matching and proposal arithmetic: truth tables, numerical examples, missing-data
policy, test matrix).

Status: **implemented on a fork branch, not approved upstream.** Discussion
kenlasko/monize#930 proposes the feature; the maintainer has not given it the
`approved-to-build` label. The branch author asked for the whole feature in one
branch. The maintainer decides whether it merges, in what slices, and the open
questions in section 12.

## 1. Goal

A bank transaction says how much and when, not what was bought. The order
confirmation email says what. The user forwards (or filters) order
confirmations to a dedicated mailbox; Monize reads that mailbox over IMAP,
read-only, finds the transaction each email pays for, and proposes an
enrichment: a description, a split by line item with a category per line, a
payee. The user approves the proposal in the review queue. Nothing is written to
the ledger without an approval, except by an opt-in auto-apply that section 7
bounds.

"AI is a compiler": a per-merchant parser is written once (by the user, or
drafted by the user's AI provider from one sample email and approved by the
user) and then runs deterministically. The AI is not called per email unless the
user chose that.

Out of scope for this branch: receipt photos and OCR (a vision pass over an
image attachment), more than one mailbox per user, POP3, and attaching the
email's PDF parts to the transaction. Section 11 records them.

## 2. What exists, and what this composes

| Piece | Where | Used for |
|---|---|---|
| Glob with named captures | `backend/src/transaction-rules/rule-glob-capture.ts` | Every extraction pattern of a parser, applied to one line at a time |
| AI review queue | `backend/src/ai-review/` | The processing queue: a proposal is a signed `PendingAiAction`, approved through `/ai/actions/confirm`, marked applied in the write's own transaction |
| Proposal validation and card | `AiReviewWorkService.submit` / `buildCard` | Exact split sum, category resolution, transfer refusal, the confirmation card |
| AI providers | `AiService.complete` | Drafting a parser from a sample; proposing an enrichment for an email no parser reads |
| Secret encryption | `EncryptionService` | The IMAP password (AES-256-GCM) |
| Egress policy | `ai/providers/provider-egress.ts`, `ai/validators/safe-url.validator.ts`, `ai/validators/private-base-url-allowlist.ts` | The IMAP host reaches only public addresses unless the owner is an admin or the operator allows it |
| Per-user lease | `JobClaimService.claimLease` | One poll per mailbox at a time across replicas |
| Payee lookup | `PayeesService.resolveByName` | The parser's payee, and the proposal's payee name |

**Why the rules engine is not the parser.** The rule condition tree and its
facts are typed to a transaction row, and the glob matcher refuses text longer
than 500 characters, finds one match per pattern and has no repetition. An
email body is thousands of characters and a receipt has N line items. So the
parser is its own small language, but every pattern in it is a rule glob,
matched by `matchGlobWithCaptures` against one line of the email's text (lines
are cut to 500 characters). No regular expression is accepted anywhere, for the
same reason the rules refuse one (ReDoS, `docs/future-plans/transaction-rules.md`
section 10.5).

## 3. Product decisions

1. **One mailbox per user**, dedicated to receipts. The settings screen says the
   mailbox should hold nothing else: every message in its folder is read.
2. **Read-only.** The folder is opened with `EXAMINE` (`readOnly: true`) and
   messages are fetched with `BODY.PEEK`. Monize never sets a flag, moves,
   deletes or appends. Progress is a UID cursor stored in Monize.
3. **TLS always.** `security` is `tls` (implicit, port 993) or `starttls`
   (port 143, upgrade required). There is no plaintext mode. The certificate is
   verified; there is no "accept any certificate" switch.
4. **First sync is bounded**: messages received in the last 30 days. After that,
   every message with a UID above the cursor, 50 per poll (operator-tunable).
5. **The review queue is the existing AI review inbox** (`/ai-reviews`). A
   receipt's proposal is a request of kind `email_receipt`. The receipts page
   (`/email-receipts`) lists every stored email with its state and the actions
   on it (link to a transaction, reprocess, recognize with AI, draft a parser,
   ignore, delete).
6. **AI mode and "Recognize with AI".** AI mode is per mailbox: `off` (the poll
   never calls the AI for receipts), `on_demand` and `automatic` (the poll asks
   the AI, bounded per tick, for a matched receipt no approved parser could
   fully read, and drafts a parser for a sender domain that has none). The mode
   governs only what happens by itself, plus "Draft parser with AI", which is
   refused in mode `off`.

   The button **"Recognize with AI"** is the person's own consent and is offered
   whatever the mode, for an email in `no_parser`, `parse_failed`, `unmatched`,
   `ambiguous`, `review_conflict`, or `review` whose shown state is `dismissed`,
   `expired` or `request_missing` (never one with an applied request, an ignored
   or a skipped one). It confirms the email's transaction (with a way to choose
   another), or opens the transaction picker (an ambiguous email lists its
   candidates first), then queues an AI review request for that transaction and
   **opens the assistant's chat** (`/ai`) with the order email attached as a text
   file and a message already typed in the composer; the assistant claims the
   request by id (`ai_review_requests` `claim` with `requestId`) and submits its
   proposal, which appears as a confirmation card in the chat and in the review
   inbox. Without an AI provider that can answer, the request waits `pending` in
   the inbox for an agent (for example over MCP) and the inbox row says so. The
   hand-off is **staged, never sent** (INV-SHARE-002's contract): the files and
   the text land on the composer and the user presses Send; it lives in memory
   only (`lib/ai-chat-handoff.ts`, nothing in browser storage). An AI answer is
   always a proposal or a draft; it is never applied or approved on its own.
7. **Auto-apply** (off by default) applies a proposal without asking only when
   all of: an approved parser read the email completely, the match is by order
   number or by exact amount plus payee with a single candidate, and the
   proposal balances to the cent. It applies through the same signed card and
   the same `/ai/actions/confirm` path a person's approval uses, so what is
   applied is what the card would have shown. Everything else waits for a
   person.
8. **A receipt that matches nothing is retried** on every poll for 30 days
   after it arrived: the bank transaction usually arrives later than the email.
9. **The email is kept** (subject, sender, date, text up to 100,000 characters)
   until the user deletes it or deletes the mailbox. The raw MIME source and
   HTML are not stored; the HTML is converted to text at ingestion.
10. **Two ways to log in**: a password (an app password for most providers) or
    OAuth2 (XOAUTH2) for Google and Microsoft 365, section 3a.
11. **Owner only.** A delegate sees neither the settings nor the receipts page,
    and the API refuses a delegate's session.

## 3a. OAuth2 login (Google, Microsoft 365)

Google and Microsoft 365 refuse a plain password on IMAP for most accounts, so
the mailbox can instead be connected with OAuth2 and logged in with SASL
XOAUTH2 (`imapflow` `auth: { user, accessToken }`).

- **The operator registers one OAuth client per provider** and sets
  `EMAIL_RECEIPTS_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` and
  `EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT`
  (default `common`). A provider without a client is not offered. The redirect
  URI to register is `{PUBLIC_APP_URL}/settings/email-receipts/oauth-callback`.
- **Scopes**: Google `https://mail.google.com/ openid email` (IMAP has no
  narrower Google scope; it is a restricted scope, so an unverified client
  works only for the test users the operator lists); Microsoft
  `https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email`.
  The scope allows writing; Monize still opens the folder read-only
  (INV-RECEIPT-001 holds by the client, not by the grant).
- **Host is fixed** by the provider: `imap.gmail.com:993` and
  `outlook.office365.com:993`, TLS. The user does not type a host, port or
  password; the login name is the `email` claim of the ID token returned by the
  token endpoint.
- **Flow** (authorization code with PKCE): `POST
  /email-receipts/mailbox/oauth/start {provider}` returns the authorization URL;
  its `state` is an encrypted, expiring envelope holding the user id, the
  provider and the PKCE verifier, and its nonce is consumed once
  (`SingleUseTokenService`). The provider redirects the browser to the frontend
  callback page, which posts `code` and `state` to the authenticated `POST
  /email-receipts/mailbox/oauth/complete`. The server checks the state belongs
  to the caller, exchanges the code, and stores the refresh token encrypted.
- **Each connection** exchanges the refresh token for an access token and
  stores a rotated refresh token when the provider returns one. A refused
  refresh (`invalid_grant`: revoked, expired, password changed) is recorded as
  the mailbox's `last_error` with the instruction to reconnect, and the poll
  stops for that mailbox until the user reconnects.
- **Disconnect** deletes the stored token; the user revokes the grant at the
  provider (the settings screen links to it).

As built (`backend/src/email-receipts/oauth/`), where the implementation is more
specific than the text above:

- **`invalid_grant` deletes the stored refresh token**, not only records it: a
  conditional UPDATE keyed on the ciphertext the call read, so a concurrent
  reconnect is never overwritten. The mailbox keeps its row, settings and
  receipts, `enabled` stays as the user left it, and `listEnabledMailboxes`
  skips an OAuth2 mailbox with no token, which is how "the poll stops" holds. The
  `last_error` line is the translated reconnect sentence. `interaction_required`,
  `consent_required` and `login_required` are treated as `invalid_grant`;
  `invalid_client` (the operator's client), `unavailable` and `rejected` keep the
  token and surface as an ordinary poll failure line.
- **The IMAP host for an OAuth2 mailbox comes from the provider table on every
  connection**, never from the stored `host` column (which is written for display
  only), so an access token can only go to the provider's own server.
- **The SASL mechanism is imapflow's choice** (XOAUTH2, or OAUTHBEARER where the
  server offers it); the redaction list covers the base64 string of both.
- **A Microsoft tenant that is not `[A-Za-z0-9][A-Za-z0-9.-]{0,99}`** makes the
  Microsoft provider unavailable (warned once) instead of building an endpoint
  from it. A Microsoft refresh request repeats the scope, as that endpoint
  expects.
- **Credentials CHECK** (`ck_email_receipt_mailboxes_credentials`): a password
  mailbox has a password, no provider and no refresh token; an OAuth2 mailbox has
  a provider and no password (its refresh token may be absent: disconnected or
  revoked).
- **Routes** beyond `start` and `complete`: `GET .../oauth/providers`,
  `DELETE .../oauth` (disconnect: token deleted, `enabled` false),
  `PATCH /email-receipts/mailbox/settings` (folder, enabled, aiMode, autoApply,
  either auth method; a folder change resets the cursor). `PUT
  /email-receipts/mailbox` on an OAuth2 mailbox switches it to password login,
  requires a password and deletes the refresh token.
- **The state nonce is claimed outside any transaction of the write**, so a
  flow whose code exchange failed stays spent and the user starts again; another
  user's attempt is refused before the claim and cannot spend it.

## 4. Data model

Four changes, one migration each (`database/migrations/`), mirrored in
`database/schema.sql`, every table with its RLS policy and
`ENABLE ROW LEVEL SECURITY` in the same file.

```
email_receipt_mailboxes              -- one per user (unique user_id)
  id, user_id
  host varchar(255), port int (1..65535), security varchar(10) 'tls'|'starttls'
  username varchar(320), password_enc text null -- EncryptionService; never returned
  auth_method varchar(10) default 'password'  'password'|'oauth2'
  oauth_provider varchar(12) null  'google'|'microsoft'
  oauth_refresh_token_enc text null             -- EncryptionService; never returned
  folder varchar(255) default 'INBOX'
  enabled bool default false
  ai_mode varchar(12) default 'off'  'off'|'on_demand'|'automatic'
  auto_apply bool default false
  uid_validity bigint null, last_uid bigint null  -- the cursor
  last_polled_at, last_success_at, last_error varchar(300), last_error_at
  created_at, updated_at

email_receipt_parsers
  id, user_id, name varchar(100)
  payee_id uuid null -> payees ON DELETE SET NULL
  from_domains text[] (1..10 entries, lower-case, no '@')
  subject_contains text[] (0..10)
  definition jsonb                               -- section 5
  status varchar(10) 'draft'|'approved', source varchar(10) 'manual'|'ai'
  approved_at timestamptz null, revision int     -- compare-and-swap
  created_at, updated_at

email_receipts
  id, user_id, mailbox_id -> email_receipt_mailboxes ON DELETE CASCADE
  uid_validity bigint, uid bigint, message_id varchar(500) null
  from_address varchar(320), from_domain varchar(255), subject varchar(500)
  received_at timestamptz, body_text text (<= 100,000 chars)
  status varchar(20)  -- section 6
  status_reason varchar(40) null
  parser_id -> email_receipt_parsers ON DELETE SET NULL
  parsed jsonb null                             -- ParsedReceipt, section 5.3
  transaction_id -> transactions ON DELETE SET NULL
  candidate_transaction_ids uuid[] (<= 10)
  match_kind varchar(20) null  'order_id'|'amount_payee'|'amount_only'|'manual'
  ai_review_request_id uuid null (no FK: the request table references this one)
  created_at, updated_at
  UNIQUE (mailbox_id, uid_validity, uid)        -- ingestion idempotency

ai_review_requests (widened)
  kind CHECK widened to ('transaction_review', 'email_receipt')
  email_receipt_id uuid null -> email_receipts ON DELETE SET NULL
```

The existing partial unique index on `(transaction_id, rule_id)` while a
request is open is kept unchanged (its predicate is what the running
`enqueue`'s `ON CONFLICT` infers during a rolling deploy). Its consequence is a
decision: one open request without a rule per transaction. A receipt whose
transaction already has an open manual or receipt request is reported as
`review_conflict` and can be reprocessed once that request closes.

Backup: `email_receipt_mailboxes` is excluded (an encrypted credential for
another instance's key, like `backup_offsite_settings`); `email_receipts` is
excluded (a mailbox copy the user can re-read); `email_receipt_parsers` is
exported, and its support-backup rules drop the free text. Section 11 records
the trade.

## 5. The parser

### 5.1 Definition (`definition` jsonb, version 1)

```json
{
  "version": 1,
  "orderId": ["*order #{orderid}*", "Order number: {orderid}"],
  "total": ["Order total: {amount}", "*Grand total*{amount}"],
  "shipping": ["Shipping: {amount}"],
  "discount": ["Discount: {amount}"],
  "items": {
    "startAfter": "Items in your order",
    "stopAt": "Subtotal",
    "patterns": ["{qty} x {name} {amount}", "{name} {amount}"]
  },
  "categoryRules": [
    { "match": "*cable*", "categoryId": "<uuid>" },
    { "match": "*book*", "categoryId": "<uuid>" }
  ],
  "defaultCategoryId": "<uuid>",
  "shippingCategoryId": "<uuid>"
}
```

- Every pattern is a rule glob (`*` wildcard, `{name}` capture), matched
  case-insensitively against one whole line. `orderId` patterns are tried on
  the subject first, then on each line.
- Capture names: `orderid` (order patterns), `amount` (total, shipping,
  discount), and in item patterns `name` (required), `amount` (the line total)
  or `price` with `qty` (the line total is `price * qty`), `qty` optional
  (default 1).
- `startAfter` / `stopAt` are plain case-insensitive substrings that bound the
  item section: items are read from the line after the first line containing
  `startAfter` (or from the top) up to the first line containing `stopAt`
  (or the end).
- A line item's category is the first `categoryRules` entry whose glob matches
  the item's name, else `defaultCategoryId`, else the parser payee's default
  category, else none.

### 5.2 Bounds (validated on save, by the same validator the AI draft passes)

At most 10 patterns per field, 200 characters per pattern, 5 captures per
pattern (the glob's own limit), 50 category rules, 100 characters per section
marker; unknown keys refused; every category id owned by the user (checked in
the write's transaction). Parsing reads at most 2,000 lines and 100 items.

### 5.3 Output (`ParsedReceipt`)

`{ orderId, total, shipping, discount, items: [{ name, qty, amount,
categoryId }], complete, reason, source? }` (`source` is `"ai"` when the AI read
the email, absent for a parser), every amount a non-negative integer in
1/10000 units. `complete` is true only when `total` was found and the items,
plus shipping, minus discount, equal the total exactly and every item and the
shipping line (when present) has a category. `reason` names the first missing
thing otherwise. The spec has the amount grammar and the truth table.

## 6. Pipeline and receipt states

```
poll -> store (status pending)
     -> choose parser: none -> no_parser
     -> parse: no total -> parse_failed
     -> match: none -> unmatched (retried 30 days) | several -> ambiguous
     -> propose: an open request exists -> review_conflict
               | proposal stored (status review)
     -> auto-apply (opt-in, section 3.7)
user -> link to a transaction (any state but ignored) -> propose
     -> ignore -> ignored
     -> reprocess -> back to the top (a closed request is not reopened)
     -> recognize with AI (any AI mode; transaction chosen or confirmed)
        -> request pending, email in review, chat opened with the email
        -> the assistant claims it by id and submits -> proposed
        (no provider: stays pending in the inbox for an agent)
```

`skipped` is a message larger than the size cap or that could not be decoded
(`status_reason` says which). The receipts page derives the shown state of a
`review` receipt from its request: `proposed`, `applied`, `dismissed`,
`expired` or `pending_ai`.

The proposal uses `AiReviewWorkService.submit` as an agent does, with the
claim key `email-receipts` (deterministic), `email-receipts-ai` (the poll's
automatic AI step) or `assistant` / an MCP caller key (the chat, or an agent,
answering a request "Recognize with AI" queued): the receipts service inserts a
deterministic request already claimed by its key, then submits; an AI request is
inserted `pending` and claimed by whoever answers it.

A deterministic proposal the validation refuses (the lines do not add up, a category
was deleted) falls back to the description-only proposal; if that is refused
too, the request is released as rejected with the reason, and the receipt
shows it.

**"Recognize with AI" in one transaction.** `POST /email-receipts/:id/ask-ai`
`{ transactionId? }` locks the receipt row, refuses (409) an ignored or skipped
email and an applied request, checks a chosen transaction with the predicate
"link" uses (`loadLinkableTransaction`: the user's, not a transfer, not VOID, not
investment-linked) and stores it as `manual`, refuses (400) an email that still
has no transaction, takes the advisory lock, dismisses the email's own open
request, queues a `pending` `email_receipt` request (a null from the queue, another
open rule-less request on the transaction, is a 409), and sets the receipt to
`review` pointing at it. It answers `{ ok: true, requestId, transactionId }` and
calls no provider. A rejection has written nothing.

**Answering by id.** `ai_review_requests` `claim` takes an optional `requestId`:
`claimById` takes that one pending request (a conditional UPDATE) instead of the
oldest, and returns the same payload, with the email's text for an
`email_receipt` request. On the assistant, `submit` returns the signed card as a
pending action in the chat; confirming it marks the request applied in the write's
own transaction (`aiReviewRequestId` in the descriptor).

**The poll's automatic step** (`processAiRequest`, mode `automatic`) takes only the pending requests the poll itself queued (their `instruction` is `RECEIPT_AUTOMATIC_AI_INSTRUCTION`; "Recognize with AI" queues `RECEIPT_CHAT_INSTRUCTION`, which belongs to the chat or an MCP agent) and asks the
model for the receipt's content, not a split: `{ orderId, items: [{ name, qty,
amount, categoryId }], shipping, shippingCategoryId, discount,
discountCategoryId, total, description }`, amounts as the email writes them. The answer becomes a `ParsedReceipt` (`source: "ai"`), is
judged by the same completeness function a parser's reading is, and goes through
`buildReceiptProposal` and `AiReviewWorkService.submit` (spec "AI extraction").

What a proposal contains:

- **Complete parse and the transaction amount equals the parsed total**: split
  lines, one per item (memo `name` or `name x qty`), plus shipping and discount
  lines, each signed like the transaction; a single line is not a split but a
  category. The description is the existing one with ` | ` and the summary
  appended (capped at 750).
- **Anything else**: the description only, with the summary; the receipt page
  names the reason (`amount_differs`, `items_uncategorized`, ...).
- **Payee**: the parser's payee name when the transaction has none.

## 7. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| INV-RECEIPT-001 | The mailbox is read, never written | The IMAP client opens the folder with `readOnly: true` and fetches with `BODY.PEEK`; the client module exposes no flag, move, delete or append call; a unit test asserts the options and a source scan asserts that `messageFlagsAdd`, `messageMove`, `messageDelete`, `append` never appear |
| INV-RECEIPT-002 | A receipt is ingested once | `UNIQUE (mailbox_id, uid_validity, uid)` with `ON CONFLICT DO NOTHING`; the cursor advances in the transaction that inserts the rows |
| INV-RECEIPT-003 | A receipt changes the ledger only through an approved (or opt-in auto-applied) card, and never moves money | The proposal is `AiReviewProposalInput` (no amount, date, account or status); it is written only by `/ai/actions/confirm` with `markApplied` in the same transaction; auto-apply calls the same `confirm` with the card it built |
| INV-RECEIPT-004 | The mailbox connection reaches only a public address unless the owner is an admin or the operator allowed the host | The host is checked on save (IP literal, blocked names, DNS) and at connect (`publicOnlyLookup` passed as the socket's `lookup`, IP literal refused) |
| INV-RECEIPT-005 | The password and the OAuth refresh and access tokens are encrypted at rest (or held only in memory) and never returned | `EncryptionService.encrypt`; the view carries `passwordSet` / `oauthConnected` booleans; the table is excluded from backups; errors are logged through `describeFetchFailure`, never with a secret |
| INV-RECEIPT-007 | An OAuth callback completes only the flow the same user started, once | The `state` envelope is encrypted, expires in 10 minutes, carries the user id checked against the JWT, and its nonce is claimed with `SingleUseTokenService` |
| INV-RECEIPT-006 | One poll per mailbox at a time across replicas | `JobClaimService.claimLease(EmailReceiptPoll, userId, mailboxId)` around the poll, released by token |

`docs/system-invariants.md` carries each with an honest status.

## 8. Backend

Module `backend/src/email-receipts/`:

- `mailbox/`: entity, DTOs, `EmailReceiptMailboxService` (get view, upsert,
  delete, test connection), host policy.
- `imap/`: `ImapMailboxClient` (the only file importing `imapflow`) and
  `mail-text.util.ts` (the only file importing `mailparser`; HTML to text,
  line normalisation, caps).
- `parsing/`: definition types, validator, `parseReceipt(definition, subject,
  text)`, amount grammar. Pure.
- `matching/`: `matchReceipt(parsed, candidates, parserPayeeId)`. Pure.
- `proposal/`: `buildReceiptProposal(parsed, transaction, context)`. Pure.
- `EmailReceiptsService`: list, get, link, ignore, delete, reprocess, ask AI.
- `EmailReceiptPipelineService`: parse, match, propose for one receipt.
- `EmailReceiptPollService`: the `@Cron` (every 15 minutes), per-user lease,
  ingestion, rematch of `unmatched`, the automatic AI step.
- `EmailReceiptAiService`: draft a parser from a receipt; `askAi` (queue the
  "Recognize with AI" request, no provider call); `processAiRequest` (the poll's
  automatic step: read the email's content, build a `ParsedReceipt`, propose).
  Uses `AiService.complete` with `responseFormat: "json"`, feature labels
  `email_receipt_parser` and `email_receipt_review`; the email text is
  sanitized, truncated and framed as untrusted data.
- `EmailReceiptParsersService` + controller: CRUD, approve, test against a
  stored receipt.

The AI review queue gains the `email_receipt` kind, `claimById`, and an
`enqueueClaimed` producer; the MCP and assistant `claim` result carries the
email (sender, subject, date, text up to 20,000 characters) for that kind, so
an MCP agent can answer a receipt request too.

Environment (operator, all optional): `EMAIL_RECEIPTS_MAX_MESSAGES_PER_POLL`
(50), `EMAIL_RECEIPTS_MAX_MESSAGE_BYTES` (2,000,000),
`EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST` (empty), and the OAuth clients of
section 3a.

## 9. Frontend

- `/settings/email-receipts`: "Connect with Google" / "Connect with Microsoft"
  (only for a provider the operator configured) or the manual mailbox form
  (write-only password, test
  connection, poll now, AI mode, auto-apply, last poll and last error), and the
  parsers list with an editor (name, domains, subject words, payee, patterns
  one per line, section markers, category rules, default and shipping
  category), a test panel against a stored receipt, approve and delete.
- `/email-receipts` (Tools menu, owner only): the receipts table with state
  badges and actions; a detail dialog with the text, the parsed result and the
  candidates.
- `/ai-reviews`: an `email_receipt` row shows the sender and subject instead of
  the rule name, and a `pending` one says it waits for an AI agent (with a link
  to the AI settings).
- `/ai`: "Recognize with AI" opens the chat with the order email attached as
  `order-email-YYYY-MM-DD.txt` and the message typed in the composer
  (`/ai?handoff=<id>`, `lib/ai-chat-handoff.ts`: in memory, one entry per id,
  discarded once staged); nothing is sent until the user presses Send.

## 10. Test matrix

| Layer | Suite | Proves |
|---|---|---|
| Unit | `parsing/*.spec.ts` | Amount grammar, item section, captures, bounds, `complete` truth table |
| Unit | `matching/*.spec.ts` | Every row of the match truth table (spec section 3) |
| Unit | `proposal/*.spec.ts` | Signs, single line vs split, shipping and discount lines, description cap |
| Unit | `imap/*.spec.ts` | Read-only options, egress lookup passed, IP literal refused, source scan of write calls |
| Unit | services | Lease, cursor, rematch window, auto-apply gate, AI modes, owner-only |
| Integration | `email-receipts.integration.spec.ts` | Ingestion idempotency on the unique key; RLS isolation of the three tables; the widened kind CHECK |
| Frontend | components | Settings form never shows the password; states and actions; inbox row for the new kind |

## 11. Deliberately left for later

- Receipt photos and PDF attachments (vision or OCR, then the same parser).
- Several mailboxes per user; a per-parser currency; tolerance for an amount
  that differs by an FX conversion.
- Backing up mailboxes (credentials) and receipts.

## 12. Open questions for the maintainer

- **Q1.** Is the review inbox the right queue, or should receipts have their
  own proposal store? (This branch reuses the inbox.)
- **Q2.** Should auto-apply exist at all, given INV-RULE-001's "never committed
  without a human approval" for AI proposals? (It is limited here to a
  deterministic, user-approved parser and a single strong match.)
- **Q3.** Retention: should stored email text be purged after N days?
