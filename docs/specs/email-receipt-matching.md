# Spec: email receipts, matching and proposal arithmetic

Status: **proposed, awaiting maintainer approval** (kenlasko/monize#930). The
design is [`../future-plans/email-receipts.md`](../future-plans/email-receipts.md).

Related: INV-RULE-001 (a proposal never moves money), INV-RECEIPT-001 to 006,
`docs/financial-semantics.md` section 5 (splits),
`docs/financial-calculation-contract.md` section 7 (rejection before write).

---

## 1. Units

Every amount the parser reads is a non-negative integer in 1/10000 units
(`12.99` is `129900`), the unit rule facts use (`rule-facts.ts`). Conversion to
a decimal happens once, when the proposal is built (`/ 10000`, then
`roundMoney`). No float is summed.

## 2. The amount grammar (`parseReceiptAmount(text)`)

Input is the text of one `{amount}` or `{price}` capture. Output is 1/10000
units or `null`.

1. Remove every character that is not a digit, `.`, `,`, `-`, `'` or a space.
   Currency symbols and codes (`$`, `zł`, `PLN`, `EUR`, `€`) go.
2. A leading `-` or a surrounding `( )` is refused (`null`): a receipt amount
   is a magnitude; a discount is its own field.
3. Remove spaces, non-breaking spaces and `'` (thousand separators).
4. The decimal separator is the last `.` or `,` when it is followed by exactly
   one or two digits and nothing else. Every other `.` or `,` is a thousand
   separator and must be followed by exactly three digits, else `null`.
5. No digits, more than 12 integer digits, or anything left over: `null`.

| Text | Result (units) |
|---|---|
| `12.99` | 129900 |
| `$1,234.56` | 12345600 |
| `1 234,56 zł` | 12345600 |
| `1.234,56 €` | 12345600 |
| `1,234` | 12340000 |
| `1234` | 12340000 |
| `12,5` | 125000 |
| `0.00` | 0 |
| `-5.00` | null |
| `1,23,4` | null |
| `abc` | null |

`qty` is a positive integer from 1 to 9999 written with digits only (a trailing
`x` or `pcs` is removed first); anything else makes the item line not match.

## 3. Matching (`matchReceipt`)

Candidates are the user's transactions, loaded in one query: not a transfer,
not VOID, not an investment row, in the currency of the account, dated from
`received_date - 3` to `received_date + 14` (calendar dates in UTC,
`addDaysYMD`), at most 200, newest first. A transaction that already has an
applied receipt, or an open receipt request, is not a candidate.

Signals per candidate:

- **O**: the parsed order id (at least 4 characters) appears, case-insensitive,
  in the transaction's `description`, `payeeName` or `referenceNumber`.
- **A**: `abs(amount)` in units equals the parsed `total` exactly. With no
  parsed total, A is false for every candidate.
- **P**: the transaction's payee is the parser's payee (by id).

| Candidates with O | with A and P | with A only | Result | `match_kind` |
|---|---|---|---|---|
| exactly 1 | any | any | that one | `order_id` |
| 2 or more | any | any | ambiguous (the O set) | -- |
| 0 | exactly 1 | any | that one | `amount_payee` |
| 0 | 2 or more | any | ambiguous (the A and P set) | -- |
| 0 | 0 | exactly 1 | that one | `amount_only` |
| 0 | 0 | 2 or more | ambiguous (the A set) | -- |
| 0 | 0 | 0 | unmatched | -- |

The candidate list stored on an ambiguous receipt is at most 10, closest date
first. A manual link sets `match_kind = manual`; the transaction must be the
user's, not a transfer and not VOID, checked in the transaction that stores the
link.

## 4. Completeness (`ParsedReceipt.complete`)

Let `S = sum(items.amount) + shipping - discount` (absent shipping or discount
is 0).

| total found | items found | S = total | every item categorised | shipping categorised (if shipping > 0) | complete | reason |
|---|---|---|---|---|---|---|
| no | -- | -- | -- | -- | false | `no_total` |
| yes | no | -- | -- | -- | false | `no_items` |
| yes | yes | no | -- | -- | false | `items_unbalanced` |
| yes | yes | yes | no | -- | false | `items_uncategorized` |
| yes | yes | yes | yes | no | false | `shipping_uncategorized` |
| yes | yes | yes | yes | yes | true | -- |

A discount needs a category only through the item it reduces: it is a line of
its own under `defaultCategoryId`, and without one the receipt is
`items_uncategorized`.

## 5. The proposal (`buildReceiptProposal`)

Let `T` be the transaction amount (signed, a decimal), `sign = T < 0 ? -1 : 1`.

| Parse complete | `abs(T)` = total | Lines | Proposal |
|---|---|---|---|
| yes | yes | 1 (one item, no shipping, no discount) | `categoryName` of the item, `description` |
| yes | yes | 2 or more | `splits`: each item `sign * amount`, memo; shipping `sign * shipping`; discount `-sign * discount`; `description` |
| yes | no | -- | `description` only, reason `amount_differs` |
| no | -- | -- | `description` only, reason from section 4 |

The split lines sum to `T` exactly by construction (section 4 proves
`S = total = abs(T)`); `AiReviewWorkService.submit` checks it again with
`sumMoney` and refuses otherwise.

**Description summary**: `"{parser name} {orderId}: item1 x2, item2"`, items
in order, joined by `, `, `x qty` only when qty > 1; the whole summary is cut
to 300 characters with `...`. It is appended to an existing description with
` | ` (`composeDescription`, 750 cap); an existing description that already
contains the summary is left as it is and the proposal carries no description.

**Payee**: `payeeName` is the parser payee's name only when the transaction has
no payee.

### Numerical example

Receipt: `2 x USB-C cable 19.98`, `Phone case 15.00`, `Shipping: 4.99`,
`Discount: 2.00`, `Order total: 37.97`. Items 199800 + 150000, shipping 49900,
discount 20000: `S = 379700 = total`. Transaction `-37.97`.

Proposal splits: `-19.98` (cable, memo `USB-C cable x 2`), `-15.00` (case),
`-4.99` (shipping), `+2.00` (discount). Sum `-37.97`.

Same receipt, transaction `-35.00` (a partial capture): description only,
reason `amount_differs`.

## 6. Missing-data policy

- No total: nothing is matched on amount; an order id may still match, and the
  proposal is description-only. The receipt page says the total was not found
  and names the parser.
- No parser for the domain: `no_parser`; the page offers "create parser" and,
  when AI mode is not `off`, "Draft parser with AI".
- A category id in a parser that was deleted: the proposal's validation refuses
  it, the fallback is description-only, and the page names the parser to fix.
- A mailbox error (DNS, TLS, login, folder): stored on the mailbox
  (`last_error`, 300 characters, log-safe) and shown on the settings screen; the
  cursor does not move.
- A receipt that is not text-decodable or above the size cap: `skipped` with
  the reason; its UID is still consumed.

## 7. Auto-apply gate

Applies only when every one holds: mailbox `auto_apply`; parser `approved`;
`complete`; `abs(T) = total`; `match_kind` is `order_id` or `amount_payee`; the
card was built. Any refusal from `confirm` (write limit, reconciled lock, a
changed row) leaves the proposal waiting in the inbox.

## 7a. AI extraction

When the poll's automatic step asks the AI about an email (`processAiRequest`),
the model returns the receipt's content, never a split of the transaction:

```json
{ "orderId": "A-1",
  "items": [ { "name": "Widget", "qty": 2, "amount": "19.98", "categoryId": "<id or null>" } ],
  "shipping": "4.99", "shippingCategoryId": "<id or null>",
  "discount": "2.00", "discountCategoryId": "<id or null>",
  "total": "37.97", "description": "..." }
```

Bounds (`email-receipt-ai.schema.ts`, unknown keys refused): at most 100 items,
names 1 to 200 characters, `qty` an integer from 1 to 9999, `description` at
most 300 characters, order id at most 100. An amount is a JSON number or text.

AI output becomes a `ParsedReceipt` (`source: "ai"`, `buildAiParsedReceipt`) and
goes through the same rules as a parser's reading:

- **Amounts.** A number must be finite and not negative and is converted once with
  `Math.round(n * 10000)`; text goes through the amount grammar of section 2 and
  must hold nothing but the amount and a currency mark. An item whose amount does
  not convert, is zero, or whose name is empty is dropped; a total, shipping or
  discount that does not convert is read as not stated (`null`). Each is noted in
  the log. A stated `0.00` shipping is a known zero.
- **Categories.** An item's `categoryId`, and the optional `shippingCategoryId`
  and `discountCategoryId`, that are not one of the user's categories (the list
  given in the prompt) are `null`. The shipping and discount categories go into
  the `ParsedReceipt` as a parser's definition would give them, so a reading with
  shipping or a discount is `complete` only when each line that exists has a
  category (`shipping_uncategorized` / `items_uncategorized` otherwise).
- **Completeness** is the table of section 4, computed by the same function
  (`completeness` in `parse-receipt.ts`), not a copy of it.
- **The proposal** is `buildReceiptProposal` (section 5) with the transaction's
  amount, description and payee and the sender's domain as the summary's label,
  submitted through `AiReviewWorkService.submit` under the AI claim key. A
  description-only result (`amount_differs`, `items_uncategorized`, ...) is still
  submitted, and its reason is stored on the email (`status_reason`) so the email
  page names it. With no item to name, the model's own `description` is the
  description. A reading with no item, no total and no description is not an
  answer: the claim is given back.
- **Storage.** The reading is stored on the email (`parsed`, with `source: "ai"`)
  by one UPDATE conditional on the email still pointing at this request, so a
  slow answer never overwrites a newer one.

Which requests the automatic step takes: pending `email_receipt` requests whose
`instruction` is the poll's own (`RECEIPT_AUTOMATIC_AI_INSTRUCTION`), unclaimed
and never tried. A request queued by "Recognize with AI" carries a different
instruction (`RECEIPT_CHAT_INSTRUCTION`) and is never taken by the poll.

"Recognize with AI" (the button) does not call this: it queues a request and the
assistant in the chat, or an agent, answers it by id with splits, which
`submit` validates as in section 5 (the lines must add up to the transaction).

## 8. Test matrix

| Case | Suite |
|---|---|
| Every row of the amount table | `parsing/receipt-amount.spec.ts` |
| Item section bounds, `price * qty`, 100-item cap, 500-character lines | `parsing/parse-receipt.spec.ts` |
| Every row of the completeness table | `parsing/parse-receipt.spec.ts` |
| Every row of the match table; date window edges (day -3, day +14, day +15) | `matching/match-receipt.spec.ts` |
| Every row of the proposal table; the numerical example; description cap and duplicate | `proposal/build-receipt-proposal.spec.ts` |
| Auto-apply gate: each condition false in turn | `email-receipt-pipeline.service.spec.ts` |
| AI extraction: amount conversion, unknown category (item, shipping, discount), dropped items, completeness through the shared function, `source: "ai"`, description-only reasons | `ai/email-receipt-ai.extraction.spec.ts`, `ai/email-receipt-ai.service.spec.ts` |
| Recognize with AI: refusals before any write, chosen transaction stored as manual, pending request visible in the inbox, claim by id, card confirm applies the request | `email-receipt-ai.service.spec.ts`, `test/integration/email-receipts-pipeline.integration.spec.ts` |
