# Backend: MCP server

The Model Context Protocol server under `backend/src/mcp/`: transport and protocol revisions, request identity, the required tool format, write confirmation, output schemas, annotations, scopes and testing. Read this before adding or changing an MCP tool, resource or prompt, or touching the transport. `backend/src/mcp/CLAUDE.md` is the short pointer; this document is where the reasoning lives. Paths are relative to `backend/src/mcp/` unless rooted.

Monize exposes its financial data over the **Model Context Protocol** so MCP clients (Claude Desktop's "Add Connector", IDE agents, etc.) can query and act on a user's finances. This directory is the whole server: transport, the `McpServer` factory, and the tool/resource/prompt definitions. Built on the v2 SDK (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`).

## Two protocol revisions, one definition

`/api/v1/mcp` answers **2026-07-28** and the **2025-era** revisions from one server definition, so the two can never drift apart.

- **Transport** (`mcp-http.controller.ts`): the SDK's `isLegacyRequest` decides which. A 2026-07-28 request goes to `createMcpHandler(..., { legacy: "reject" })` through `toNodeHandler`; a 2025-era one keeps the sessionful transport (one `NodeStreamableHTTPServerTransport` + one `McpServer` per `Mcp-Session-Id`, 1h TTL, per-user cap, periodic cleanup). Use the predicate, never a header check: it answers a malformed envelope, a version header without one, and header/body mismatches from the modern path with modern error codes, and a request routed the other way is refused in the wrong shape. `@SkipCsrf()` + bearer auth only (no cookies).
- **The legacy path stays selected on purpose.** The SDK's stateless legacy fallback would serve a 2025-era client from an instance that holds nothing between rounds, and our 2025 confirmation is a server-initiated elicitation that waits.
- **GET and DELETE are 2025-era session operations.** Without a session id they answer `405` with `Allow: POST`: the new revision has no standalone stream and no session to end.
- **Auth** (`validatePat`): `Authorization: Bearer <token>`. `pat_*` tokens go through `PatService`; everything else is treated as an OAuth 2.1 access token (`OAuthProviderService`). A 401 returns `WWW-Authenticate` with `resource_metadata` (RFC 9728) pointing at `/.well-known/oauth-protected-resource`. A credential that cannot be identified (an OAuth grant with no id) is refused with 403 rather than served.
- **Server factory** (`mcp-server.service.ts`): `createServer()` builds a fresh `McpServer`, sets `instructions`, capabilities, cache hints and the confirmation options, and registers every tool/resource/prompt. The modern handler calls it per request, the sessionful path once per session. It deliberately takes no era: a factory that cannot see which revision asked cannot answer them differently. The server `version` is read from `backend/package.json` -- never hardcode it.

## A 2025-era session lives in one process, and cannot be moved to another

Everything a 2025-era exchange needs is held by the replica that answered
`initialize`, and none of it is addressable by the session id:

- **The id cannot be put back.** `NodeStreamableHTTPServerTransport.sessionId` is
  a getter with no setter, `_initialized` is private and set only by handling an
  `initialize` request, and `validateSession` answers `400 Bad Request: Server
  not initialized` to every other request that reaches a transport which has not
  seen one. `mcp-http.controller.spec.ts` pins both, so an SDK that grows a
  session-restore seam turns red here rather than leaving the deployment rule
  below standing on a limitation that has lapsed.
- **The live state is not the id.** The open response stream is bound to that
  pod's socket, the promise a `confirmWrite` elicitation waits on is an entry in
  that process's `Protocol._responseHandlers`, and the observed-behaviour record
  is keyed on that `McpServer`.

So an `mcp_sessions` table would make a session id resolvable and still not make
the session servable. The four maps in `mcp-http.controller.ts` stay process-local
and the 5-minute sweep stays a `setInterval`: both are correct for state that
cannot outlive its process.

**More than one backend replica therefore needs sticky routing on the MCP path**
(`mcp.stickySessions` in the chart; `helm/README.md` has the mechanism and its
three limits). Without it a session id lands on the wrong replica and is answered
`404 Session not found`, which the spec requires a client to recover from by
re-initializing. Reads recover; a confirmation in flight does not. Its answer
never reaches the replica that asked, that replica's wait expires, and
`clientAnsweredForItself` reads the timeout as `"unsupported"` -- so the write
proceeds under the client's own approval prompt rather than the dialog's.

The 2026-07-28 leg has none of this and needs none of it: no session, no
server-side wait, a fresh server per request.

## Identity is a property of the request, not of a session

A 2026-07-28 request has no session at all, and even on a 2025-era connection the bearer rides on every request. So the transport validates the credential and attaches it as the SDK's `AuthInfo` (`toAuthInfo`), and a handler reads the caller from `resolveUserContext(ctx)` -- which validates the shape rather than casting it. `userId` never comes from tool arguments, and no tool reads a session map. That is INV-MCP-001 restated per request; a 2025-era session is additionally bound to the credential that opened it.

**"Which session is this" became "which caller is this"** (`callerKey`): the session id on a 2025-era connection, the credential id where there is no session. Only two things ask -- the relay claim and the observed-elicitation record -- and on a 2025-era connection nothing changes. The cost on 2026-07-28 is that two clients sharing one token share a caller key, so a user who wants the web-chat relay and a direct client at once should mint a token for the agent alone (the connect instructions say so).

An MCP credential (PAT or OAuth token) is always the owner's own: no MCP request acts as a delegate, so a read tool whose domain method narrows by a delegate's account scope (`list_warranties` over `WarrantiesService.getLlmWarranties`) passes none.

`search_help` (`tools/help.tool.ts`) reads no user data at all: it answers sections of the bundled user guide through `HelpService.getLlmHelp`, the assistant's own method. It is read-only (`READ_ONLY`), needs the `read` scope like every read tool and asks for no confirmation. The server instructions point a client at it for questions about using Monize.

## Directory layout

```
mcp/
  mcp-http.controller.ts     # Streamable HTTP transport: era routing, sessions, auth
  mcp-server.service.ts      # createServer(): wires everything onto an McpServer
  mcp-context.ts             # request identity (toAuthInfo/resolveUserContext/callerKey),
                             # requireScope, toolResult/toolError, sanitization
  mcp-confirm.ts             # the write confirmation, in both revisions' shapes,
                             # and the round-stable projection it fingerprints
  mcp-request-state.ts       # the seal a multi round-trip confirmation carries
  mcp-annotations.ts         # shared tool annotation presets (READ_ONLY/CREATE/UPDATE)
  mcp-write-limiter.ts       # per-user daily write cap for mutating tools
  mcp-elicitation-support.ts # what each session's client does with elicitation
  tool-output-schemas.ts     # one Zod output schema (raw shape) per tool
  tools/<domain>.tool.ts     # tool definitions, grouped by domain
  resources/<name>.resource.ts
  prompts/<name>.prompt.ts
  mcp.module.ts              # NestJS providers/imports
```

Each tool/resource/prompt is an `@Injectable()` class with a `register(server)` method, listed in both `mcp.module.ts` (providers) and `mcp-server.service.ts` (wired into `createServer`).

## Adding a tool (required format)

Every tool MUST declare **`title`**, **`description`**, **`inputSchema`**, **`outputSchema`**, and **`annotations`**. The handler MUST resolve context, check scope, run inside try/catch, and return via `toolResult` / `safeToolError`.

```typescript
server.registerTool(
  "get_thing",
  {
    title: "Get thing",                 // human-readable display name
    annotations: READ_ONLY,             // from mcp-annotations.ts
    description: "What it does and when to use it (guide the model).",
    inputSchema: z.object({             // an explicit z.object; z.object({}) if no args
      id: uuidString().describe("Thing ID"),
    }),
    outputSchema: getThingOutput,       // from tool-output-schemas.ts
  },
  async (args, ctx) => {
    const user = resolveUserContext(ctx);
    if (!user) return toolError("No user context");
    const check = requireScope(user.scopes, "read");
    if (check.error) return check.result;
    try {
      const data = await this.thingService.getLlmThing(user.userId, args.id);
      return toolResult(data);
    } catch (err: unknown) {
      return safeToolError(err);        // never leak 5xx internals
    }
  },
);
```

The local is named `user`, never `ctx`: `ctx` is the SDK's request context, and the source scan in `mcp-migration.guard.spec.ts` reads the difference. A raw Zod shape still compiles (the SDK keeps a deprecated overload) but is not the supported form.

Checklist for a new tool:

1. Put the data logic on the **domain service** (e.g. `getLlm*`), not in the tool. Per the repo rule, the same logic is shared with the AI Assistant tool executor and both must return the same shape -- wire both surfaces in the same PR.
2. Add the tool to its domain `tools/*.tool.ts` with the five config fields above.
3. Add its output schema to `tool-output-schemas.ts` (conventions below) and import it.
4. Pick the right annotation preset (below).
5. If it mutates data, derive scope `"write"`, enforce the daily write limit via `McpWriteLimiter` (see `transactions.tool.ts`), and sanitize user strings with `stripHtml(...)` before persisting. Gate the write behind a user confirmation with `confirmWrite(server, ctx, message, action)`, passing the signed action descriptor as it is -- `confirmationFingerprint` strips the per-build fields itself (see below), so a caller neither may nor need pre-trim it. **Handle all four outcomes**: return `outcome.ask` unchanged when `isAsk(outcome)` (the question, on 2026-07-28 -- write nothing), persist on `"accepted"`/`"unsupported"`, and return a `toolError` without writing on `"declined"`. `"unsupported"` means no dialog reached a human -- the client still gates every tool call with its own approval prompt, so proceeding is not a consent bypass.
   - **Relay first.** When the call is serving a prompt the user typed in the Monize web chat (reverse relay), confirm there instead: build the signed `PendingAiAction` with `AiActionBuilderService` (shared with the AI Assistant tool executor) and emit it. If the card is shown in the browser (committed via `/ai/actions/confirm` on approval), return `RELAY_PREVIEW_SHOWN` and do NOT write or `confirmWrite`; otherwise fall through to `confirmWrite`. Offer the card only when `ctx.mcpReq.requestState()` is absent -- a retry round already carries the user's answer.
6. Update `mcp-server.service.ts` count and `mcp.module.ts` if it's a new provider class.
7. Add/extend tests (below). `mcp-annotations.spec.ts` enforces that every tool has title + input/output schema + annotations with the right read/write hints -- bump `EXPECTED_TOOL_COUNT` and `WRITE_TOOLS`/`IDEMPOTENT_WRITES`.

## A write is confirmed twice over, in two different shapes

Every write is confirmed by a human before it is saved, and how that question is asked depends on the revision. `confirmWrite` / `confirmWriteMany` (`mcp-confirm.ts`) is the only place either shape is written.

**On 2026-07-28 there is no server-initiated request, so the tool answers with the question.** Round one returns `{ ask }` -- an `input_required` result carrying a sealed `requestState` -- which the tool returns untouched, writing nothing. The client shows the dialogs and calls the tool again with the answers; round two re-derives the same items and reads them. The server holds nothing in between, which is what makes the endpoint stateless.

Three properties make that round trip safe, and all three live in the seal (`mcp-request-state.ts`, verified by the SDK seam before any handler runs):

- **It is bound to the credential and the method.** A confirmation cannot be replayed by another caller or against another tool. It is not single-use: the same seal and the same answer, re-sent by the same credential against the same tool inside the TTL, commits again. A client able to do that could equally have fabricated the `accept` in the first place -- the answer is client-asserted on this revision, exactly as it is on the 2025-era one -- so the seal bounds who and what, never how many times.
- **It carries a fingerprint of what the user was shown**, recomputed on the round that writes. A retry that re-derived different rows -- a name that now resolves elsewhere, an amount the model altered -- is refused with a message telling the model to ask again. The seam can prove the state is ours and unexpired; only the fingerprint can prove it is about *this* change.
- **What is fingerprinted is the change, not the round it was built in.** Round two is a separate tool call, so it rebuilds its descriptor: `actionId` is a fresh UUID, `expiresAt` a fresh clock reading, and an attachment's `attachmentRefId` a fresh parking slot. `roundStableAction` drops exactly those at every depth (the envelope half from `AI_ACTION_ENVELOPE_FIELDS`, so the descriptor's own declaration is the list and the compiler refuses a new per-build field that is not on it); everything that says *what* is being approved -- amounts, ids, dates, an attachment's `sha256` -- stays in. Hashing the descriptor raw is not a smaller version of this: it makes every fingerprint unique, so every confirmed write on 2026-07-28 is refused with "the confirmation no longer matches the change". `mcp-migration.guard.spec.ts` fails on the raw form, and `mcp-confirm.spec.ts` drives the **real** action builder twice -- a builder double that returns one frozen object agrees with itself no matter what is hashed, which is how the defect shipped green.
- **It is signed, not encrypted.** The client can read the payload, so it holds a fingerprint and nothing else: no row ids, no amounts, no names.

Every card's item comes from `confirmItemsForCards`, so what a card is fingerprinted under is one decision rather than one per tool.

Two consequences to keep: **individual approval mode asks for every card in ONE round** (a round per card would be 25 rounds on a full batch, and the flow allows two), and **a relay card is offered only on the round that asks** -- on a retry the human has already answered in their own client, and a web-chat turn that began in between would swallow that answer.

**A `dryRun` previews through the path its save would take.** `manage_transactions` saves a single item, and `approvalMode: "individual"` (which `resolveApprovalMode` picks below `BULK_APPROVAL_THRESHOLD` items), one card per row, where a transfer edit is a card of its own; only a bulk card skips transfers. Its update preview follows the same choice: `TransactionToolPrepService.prepareUpdateEach` for the first two, `prepareUpdateBulk` for the bulk card, both mapping a row through `updatePreviewRow`. Previewing every update through the bulk preparer refused a single transfer tag edit that the save then applied.

**On a 2025-era connection the server asks and waits**, exactly as it always did, through `ctx.mcpReq.elicitInput` (which relates the dialog to the tool call; a server-to-client request with no relation goes to the standalone GET stream, which a tool-calling client does not hold open). The SDK's own `legacyShim` is off: our fallback for a client that cannot show a dialog is behavioural, and a shim cannot reproduce it.

## An advertised capability is not evidence; observed behaviour is

`confirmWrite` used to read `getClientCapabilities().elicitation.form` as proof that a confirmation dialog could be shown, and therefore treated every failure of that dialog as the user saying no. The SDK rewrites the legacy 2025-06-18 shape `{"elicitation":{}}` into `{"elicitation":{"form":{}}}` before `getClientCapabilities()` ever sees it, so the check stopped separating a client that shows dialogs from one that answers `-32601` or never answers at all -- and every write through such a client was refused, or hung until the client abandoned the tool call. **A capability the SDK synthesizes cannot carry a decision.**

So the outcome decides, not the advertisement:

- Only a returned `action` is a user's answer. A rejection whose code says the client answered for itself (`clientAnsweredForItself` in `mcp-elicitation-support.ts`: method not found, invalid request/params, parse error, connection closed, request timeout) is `"unsupported"`; an unaccounted-for failure shape stays `"declined"`, so a case nobody has reasoned about refuses the write.
- Behaviour is remembered per session, in a `WeakMap` keyed on the session's `McpServer` so the record dies with the session. A client caught answering for itself is not asked again (the round trip costs `CONFIRM_TIMEOUT_MS` per row otherwise); a client that has answered once is never demoted, so a later unanswered dialog on it is `"declined"`.
- **The wait must expire before the client abandons the tool call waiting on it.** Claude's MCP tool deadline is 60s; a five-minute server-side wait produced no result at all, only an opaque client-side timeout. `mcp-confirm.spec.ts` fails if `CONFIRM_TIMEOUT_MS` leaves that range, and pins the SDK normalization above so it cannot silently become load-bearing again. A 2026-07-28 request has no server-side wait at all, so the human's window there is the seal's own TTL.
- The record is legacy-only, and so is the memory: a 2026-07-28 request gets a fresh server and has nothing to save.

## A relay turn belongs to one caller, for a bounded time

The same user can have two MCP clients at once -- the agent running the web-chat relay loop, and a direct client (Claude Desktop) they are typing at. Only one is serving a browser prompt, so **"does this write belong to the web chat" is a question about the calling client, not about the user**.

The caller key is the session id on a 2025-era connection and the credential id on a 2026-07-28 request (`callerKey`), because that revision has no session to ask about. Two clients on one token therefore share a key: mint the relay agent its own.

- Emit a card with `emitRelayCard(this.relayService, userId, action)` (`mcp-relay-confirm.ts`), never `relayService.emitPendingAction` directly: the helper supplies the ambient caller key the decision depends on. `mcp-relay-confirm.spec.ts` scans the tool sources and fails on a direct call.
- A relay turn is a prompt **claimed by this caller** (`waitForPrompt` records `claimedBy`), or one of its claims that timed out within the late-answer retention window. It is not connection liveness, not user-wide, and not unbounded in time -- each of those was tried, and each routed a direct client's confirmation into a web chat nobody was watching (the worst version captured every direct write the user made afterwards, permanently).
- Liveness is caller-scoped for the same reason: a direct client's tool calls are not evidence that another caller's agent is still working.

## A proposal is not a write: `ai_review_requests`

`ai_review_requests` (`tools/ai-review.tool.ts`, `operation`: list, claim, submit, reject) lets an agent work the AI review queue a rule fills (`request_ai_review`). It confirms nothing and spends none of the daily write cap, because none of its operations writes the ledger: `submit` stores a **signed card** on the request and stops (`update_transaction` for a receipt or a review, `create_investment_transaction` for an `email_trade` request answered with the `trade` field), and the person approves it in the review inbox through `/ai/actions/confirm`, which is counted where it happens. Do not "fix" this by adding `confirmWrite` here; a dialog in the agent's client for a proposal the person has not yet seen would ask the wrong person at the wrong time.

- **On a web-chat relay turn `submit` also offers the same card to the chat** through `emitRelayCard` (first round only), so the person can approve it there as well as in the inbox; the proposal is stored either way and the result says the card was shown.
- **The claim key is `callerKey(ctx)`** (the session id on a 2025-era connection, the credential id on 2026-07-28), so two agents on one token share a claim: mint the queue agent its own token. A request is answered only by the key that claimed it; `submitProposal` and `release` are conditional `UPDATE`s on `claimed_by`, so the read check before them refuses early and the update is the authority.
- **`claim` returns the request and its transaction through `getLlmTransactionById`**, the projection `list_transactions` uses, never a raw row. The instruction is the user's own text; the tool guidance tells the model to treat it, and the transaction's text, as data.
- **`reject` returns the request to `pending`** with the claim cleared and the reason kept for the next agent, or closes it (`rejected`) with `cannotBeDone`. Returning is the default so an agent that merely could not read an order does not close the request for everyone; closing exists so an impossible request is not handed out forever.
- **Scopes:** `read` for `list`, `write` for the rest.

`email_receipt_parsers` (`tools/email-receipt-parsers.tool.ts`, `operation`: test, save_draft, categories, get) is its sibling for the parser drafts a person asks for from the receipts page. It confirms nothing and spends no write cap: it reads no mail (the claimed request carries the emails' text), `test` runs a draft against them without storing, and `save_draft` stores a DISABLED parser the person still approves. `get` reads the saved parsers: without `parserId` a summary list (`{ parsers }`), with one the parser in full in any status (definition with category names, which `test` and `save_draft` accept as written) so an agent can start a NEW draft from it; a revise request carries the draft's `parserId` for this. Scopes: `read` for `test`, `categories` and `get`, `write` for `save_draft`; annotation `CREATE`. It has its own entry in the `tools/list` byte budget (`tools-list-budget.spec.ts`); keep the description short and do not lengthen `ai_review_requests` to explain it. The description is sized to the byte against that cap, so the whole parser language (every field the validator accepts) is returned by the `categories` operation as `guide` (`EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE`, `email-receipts/parsers/parser-tool.guide.ts`), and `test` returns each email's `outcome` (`no_html` when the definition's `source` is `html` and the email has no HTML part) and `trace`. `test` reads the lines of the definition's own `source` (`text`, the default, or `html`; documented in the guide, never in the description, which has no room), so no tool input changed.

## Tags: one door, one executor

`list_tags` and `manage_tags` (`tools/tags.tool.ts`) are thin adapters over `TagsService.getLlmTags` and `TagToolPrepService` (`src/tags/tag-tool-prep.service.ts`), the methods the assistant's executor calls, with one description and input schema for `list_tags` on both surfaces (`LIST_TAGS_DESCRIPTION`, `listTagsSchema`). `manage_tags` proposes `create_tag` / `update_tag` / `delete_tag` cards (a `batch_actions` envelope with a `*_tag` operation at six or more items) and commits an approved one through `AiActionsService.commitApproved`, as `manage_transaction_rules` does, so a tag write has no second executor here. Tagging transactions is not this tool's job: `manage_transactions` takes `addTagNames` / `removeTagNames` on an update, and every commit of an approved edit, on either surface, maps the signed descriptor through `updateTransactionCommitArgs` / `updateTransferCommitArgs` (`src/ai/actions/edit-commit-args.ts`), so no path can drop a field the card showed.

## `toolResult` and structured content

`toolResult(data)` is the only success path. It sanitizes every string in the payload (`sanitizeToolResultStrings`), normalizes non-finite numbers to `null`, and returns **`structuredContent` alone**: objects pass through; bare arrays are wrapped under `items`; primitives under `value`.

**It deliberately does not also emit the payload as a text block.** The spec suggests a serialized-JSON `content` entry for clients too old to read `structuredContent`, and this server did that -- pretty-printed, so every answer travelled twice and a model paid for both halves. A page of transactions or a portfolio summary dwarfs the tool definition that asked for it, so the duplicate was the larger half of the per-request cost. The trade is explicit: a client that cannot read `structuredContent` now sees an empty result rather than a degraded one, and restoring the block is a one-line change in `mcp-context.ts`. Errors keep their text (`toolError` carries no structured content and bypasses output validation).

A tool's own spec therefore asserts on `result.structuredContent`, not on parsed `content[0].text`.

## A tool definition is paid for on every request

Every byte of `tools/list` -- title, description, both schemas, annotations -- rides in the model's context on **every** request, and the server instructions ride beside it. This payload reached 78,207 bytes (~11,600 tokens) for 20 tools before anything measured it, because each defect fix appended a paragraph and the same fact was stated in the tool description, again in the field's `.describe()`, and again in the instructions.

A fact lives in exactly one place:

| Place | Carries |
|---|---|
| `description` | What the tool does, when to prefer it, and the one or two semantics a model gets wrong (a withheld total, an editing contract). |
| A field's `.describe()` | How to fill *that* field, terse. An enum's own field is where its members are explained. |
| Server `instructions` | Cross-tool conventions, once: signed amounts, name resolution, date formats, the approval rule shared by every `manage_*` tool. |

- **Never restate an enum's members in prose.** The `z.enum` already ships them.
- **Never describe another surface or the codebase's history.** "Returns the same shape as the AI Assistant's tool" and "replaces the former get_accounts" guide nobody holding this tool.
- **Shared input shapes live in `tools/schema-fragments.ts`** (`uuidString`, `ymdDate`, `nameList`, `manageOperation`, `approvalMode`, `dryRun`, `itemsArray`). `z.string().uuid()` emits `format: "uuid"` *and* a 166-character pattern, per tool; the fragment is 75 characters. Its regex carries no flags on purpose -- zod serializes `regex.source`, so a flag would be enforced by the server's parse and silently absent from the client's schema. `schema-fragments.guard.spec.ts` fails on a second copy.
- **Guidance for one kind of turn travels with that turn.** The relay's heartbeat and batching rules are returned as `guidance` on a claimed prompt (`relay-guidance.ts`), not carried by every client that never relays.

`tools-list-budget.spec.ts` serializes the real `tools/list` through the SDK and fails above a per-tool cap, a total cap and an instructions cap, printing the whole table on failure. The caps are a **ratchet**: lower one when a tool shrinks; raising one is a reviewed decision, not the fix for a red build. It also pins the listed order (2026-07-28 asks for a deterministic one) and scans for restated enum lists and banned phrases.

## A model writes JSON by hand, so a numeric argument arrives as a string

`limit: "10"` is what an LLM emits often enough that refusing it is a defect: the SDK validated `list_payees` against a bare `z.number()` and answered `-32602 expected number, received string` to a request that was perfectly clear. Every numeric tool input goes through `numberArg(...)` and every boolean through `booleanArg()` (`common/tool-schemas.ts`), on the MCP surface and the AI Assistant's alike.

Neither is `z.coerce.*`, and both reasons matter. `z.coerce.number()` is `Number(value)`, so it reads `""`, `"   "`, `null` and `[]` as **0** -- an unknown arriving as a measured zero, which on `minAmount` filters at zero and on an `amount` would post a transaction for nothing. `z.coerce.boolean()` is `Boolean(value)`, so it reads `"false"` as TRUE -- the one input a caller most needs it to get right, since `hasEmail: "false"` is how you ask which payees are *missing* one. Both helpers convert only what is unambiguous and leave everything else to be refused.

Bounds go inside (`numberArg(z.number().int().min(1).max(500))`), because they belong to the number. Both serialize to exactly the JSON Schema the bare form would, so the tolerance costs no `tools/list` bytes -- a union would have emitted an `anyOf` per field. `schema-fragments.guard.spec.ts` fails on a bare `z.number()` or `z.boolean()` in any tool file.

## Output schema conventions (`tool-output-schemas.ts`)

Each export is a **loose `z.object`** built with `toolOutput(...)` -- a schema instance, which `registerTool` accepts alongside a raw shape.

**The declaration does not decide what reaches the caller.** The server validates `structuredContent` with `safeParseAsync` and then sends the handler's *original* object, so no field is ever stripped on the way out. What it decides is the JSON Schema the **client** validates against with ajv: a raw shape is wrapped in a strip-mode object, serialized as `additionalProperties: false`, and the client then rejects the very fields the tools return. Loose emits `additionalProperties: {}`.

So declare what a model must **reason about**, and let the rest ride in the payload:

- **Declare** totals, counts, completeness flags (`fxComplete`, `valuationComplete`, `amountsComplete`, and the per-account ones -- an account's totals are in *its* currency, so a global flag cannot speak for them), the currency a total is in (`totalsCurrency`), a `known*Subtotal`, a skipped row's `reason`, and any id the model must copy back (`securityId`, a scheduled item's `id`, an attachment's `uri`).
- **Do not declare** row-level display columns. `rows()` is `z.array(looseObject({}))`.
- Build every nested object with `looseObject(...)`, never a bare `z.object(...)`.
- Money/decimals are numbers at runtime (entity `numericTransformer`). Use the shared `num` (`z.number().nullable()`). A divide-by-zero percentage is `NaN`, which `toolResult` normalizes to `null`. Do **not** use `z.nan()`: the SDK's JSON Schema serialization throws, failing the entire `tools/list` response and leaving every client showing zero tools.
- Use `.nullable()` for documented-null fields and `.optional()` for fields that may be absent, including alternate result branches.
- Array-returning tools wrap under `items`, matching `toolResult`'s array wrapping.

`tool-output-schemas.spec.ts` asserts the property the shallowness depends on: an undeclared field, top-level and inside a row, still reaches the client. Its `listTools()` call is load-bearing -- the client builds its output validator there, so a `callTool` without it validates nothing and the assertion would prove nothing.

## Annotation presets (`mcp-annotations.ts`)

All tools operate on the user's own closed dataset, so `openWorldHint` is always `false`. Pick by effect:

| Preset | Use for | Hints |
|--------|---------|-------|
| `READ_ONLY` | queries/aggregations/`calculate` | `readOnlyHint: true` |
| `CREATE` | adds a new record | `readOnlyHint:false, destructiveHint:false, idempotentHint:false` |
| `UPDATE` | sets fields to given values | `readOnlyHint:false, destructiveHint:false, idempotentHint:true` |

There is no destructive preset for a read tool. The six `manage_*` tools (`manage_transactions`, `manage_payees`, `manage_tags`, `manage_securities`, `manage_investment_transactions`, `manage_transaction_rules`) take `operation: "delete"` and are annotated `destructiveHint: true`; `manage_transaction_rules` also folds its two reads (`list`, `test`) into the one tool to keep `tools/list` small, and requires `read` for those and `write` for the rest. `manage_securities` does the same for its `list` operation, which takes an `accountName` instead of items and returns the securities held in that account. `ai_review_requests` is `CREATE`: it changes queue rows, never the ledger (next section).

**A scanner flagging "delete" in those descriptions is reporting a real capability, not a defect.** Do not reword it away: a description that hides what the tool can do is worse than the finding. The mitigations are the annotation, the `write` scope, `McpWriteLimiter`'s daily cap, and a user confirmation before every write (a relay card, or an elicitation dialog). `lookup_securities` is the one rename that was worth making -- its text field is `search`, matching every other read tool, because `query` was flagged purely as a name and nothing there builds SQL.

## Scopes

`requireScope(ctx.scopes, ...)` gates each handler. Scopes in use: `read` (queries, including report/anomaly tools) and `write` (mutations). Resources gate with `hasScope(ctx.scopes, "read")`. There is no separate `reports` scope: the OAuth layer only issues `monize:read`/`monize:write`, so reports are folded into `read`.

## Resources & prompts

- **Resources** (`registerResource`): `title` + `description`, return `contents[]` with `mimeType: "application/json"` and the JSON `text`. Same context-resolve + `hasScope` check; on error return a `contents` entry with an `Error: ...` text rather than throwing.
- **Prompts** (`registerPrompt`): `title` + `description` + `argsSchema` (Zod raw shape of optional args), return `messages[]`. Prompts are templates only -- no data access, no scope check.

## Security (do not regress)

- `userId` is always from the session context, never from tool args.
- Sanitize user-controlled strings written back: `stripHtml()` before persist; `toolResult` runs `sanitizeToolResultStrings` on all outgoing strings.
- `safeToolError` passes through 4xx messages but returns a generic message for 5xx/unknown errors -- never leak internals.
- Transport is bearer-only and `@SkipCsrf()`; do not add cookie auth here.

## Testing

Tools/resources/prompts unit tests mock `registerTool`/`registerResource`/`registerPrompt` to capture the handler, then drive it with a mocked service and a built request context (`testing/mcp-test-context.ts`, whose `mcpTestCtx(user, options)` carries the caller as the request's own `AuthInfo`), asserting on `result.structuredContent` and `result.isError`. A spec that needs a 2026-07-28 request passes `sessionId: undefined` and an `envelope`. Plus:

- `mcp-annotations.spec.ts` -- every tool has title + input/output schema + annotations with correct read/write hints (update its constants when adding a tool).
- `tool-output-schemas.spec.ts` -- each output schema accepts a representative `toolResult` payload (incl. NaN, null, and alternate branches), and an end-to-end round-trip through the real SDK via `InMemoryTransport`.
- `mcp-server.service.spec.ts` -- registration counts, the advertised version tracking `package.json`, the cache fields on a real listing, and the absence of the `logging` capability.
- `mcp-eras.spec.ts` -- **both revisions, in process, against the real SDK**: a client pinned to 2026-07-28 over `handler.fetch` and a 2025-era client over `InMemoryTransport` reach the same tools and resolve the same caller, and a write is confirmed in two rounds (accepted, declined, and never answered). A mocked transport cannot show any of that.
- `mcp-confirm.spec.ts` -- the confirmation matrix in both shapes, a seal replayed under another credential or another tool, and the fingerprint of a **real** built action holding across two rounds while still separating two different changes.
- `mcp-migration.guard.spec.ts` -- the mechanical rules: no 1.x import, no session-shaped identity read, no tool building its own `inputRequired`, reading `inputResponses` or mapping its own confirmation cards, every tool that confirms a write handling the unanswered round, and the fingerprint taken over the round-stable projection.

## Spec compliance notes

**Revision 2026-07-28**, served beside the 2025-era revisions: the stateless per-request core (no session, no `initialize`), `server/discover`, multi round-trip write confirmation, `ttlMs`/`cacheScope` on every cacheable result, the `Mcp-Method`/`Mcp-Name` routing headers and an `MCP-Protocol-Version` header that must name the same revision as the `_meta` envelope (allowed through CORS; the SDK validates them and refuses a body that names a revision without the header), OAuth 2.1 + RFC 9728 protected-resource metadata with the `iss` parameter (RFC 9207) on the authorization response.

Tools carry title, description, input and output schema and annotations; resources carry title, description, mimeType and a cache hint; prompts carry title, description and arguments. Declared capabilities are `tools`, `resources` and `prompts`.

**Intentionally not implemented**, each because nothing asks for it yet:

| Not implemented | Why |
|---|---|
| `logging` | Removed as a capability here: `logging/setLevel` is gone in this revision and the feature is deprecated (SEP-2577). Nothing ever sent a log notification. |
| `subscriptions/listen`, resource `subscribe`/`listChanged` | No client subscribes, and the data behind these resources is read live. |
| `completions` | Argument autocompletion; no client asks. |
| The tasks extension (`io.modelcontextprotocol/tasks`) | Every tool here answers within a request. |
| `x-mcp-header` / `Mcp-Param-*` mirroring | No tool argument needs to be visible to an intermediary. |
| DNS-rebinding protection | Auth is bearer-only, so there are no ambient browser credentials to steal. |
| Client ID Metadata Documents | `docs/future-plans/mcp-client-id-metadata-documents.md`; DCR still works and nothing presents a URL as its `client_id`. |

The 2025-era session path is the one piece with an end date: once no client negotiates that revision, `legacy: "reject"` on the whole endpoint retires the session table and `mcp-elicitation-support.ts` with it.
