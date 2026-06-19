# MCP Server

Monize exposes its financial data over the **Model Context Protocol** so MCP
clients (Claude Desktop's "Add Connector", IDE agents, etc.) can query and act
on a user's finances. This directory is the whole server: transport, the
per-session `McpServer` factory, and the tool/resource/prompt definitions.

Built on `@modelcontextprotocol/sdk` (`McpServer` + `StreamableHTTPServerTransport`).

## Architecture

- **Transport** (`mcp-http.controller.ts`): Streamable HTTP at `POST/GET/DELETE /mcp`.
  Manages one transport + one `McpServer` per session, keyed by the
  `Mcp-Session-Id` header. Sessions have a 1h TTL, a per-user cap, and periodic
  cleanup. `@SkipCsrf()` + bearer auth only (no cookies).
- **Auth** (`validatePat`): `Authorization: Bearer <token>`. `pat_*` tokens go
  through `PatService`; everything else is treated as an OAuth 2.1 access token
  (`OAuthProviderService`). A 401 returns `WWW-Authenticate` with
  `resource_metadata` (RFC 9728) pointing at `/.well-known/oauth-protected-resource`.
- **Server factory** (`mcp-server.service.ts`): `createServer(resolve)` builds a
  fresh `McpServer`, sets `instructions` + capabilities (logging, tools,
  resources, prompts), and registers every tool/resource/prompt. The server
  `version` is read from `backend/package.json` so it tracks the released image
  automatically -- never hardcode it.
- **Per-request user context** (`mcp-context.ts`): the controller passes a
  `resolve(sessionId)` that returns `{ userId, scopes }`. Handlers call
  `resolve(extra.sessionId)` to get the caller; `userId` always comes from the
  session, never from tool arguments.

## Directory layout

```
mcp/
  mcp-http.controller.ts     # Streamable HTTP transport + sessions + auth
  mcp-server.service.ts      # createServer(): wires everything onto an McpServer
  mcp-context.ts             # resolve, requireScope, toolResult/toolError, sanitization
  mcp-annotations.ts         # shared tool annotation presets (READ_ONLY/CREATE/UPDATE)
  mcp-write-limiter.ts       # per-user daily write cap for mutating tools
  tool-output-schemas.ts     # one Zod output schema (raw shape) per tool
  tools/<domain>.tool.ts     # tool definitions, grouped by domain
  resources/<name>.resource.ts
  prompts/<name>.prompt.ts
  mcp.module.ts              # NestJS providers/imports
```

Each tool/resource/prompt is an `@Injectable()` class with a `register(server, resolve)`
method, listed in both `mcp.module.ts` (providers) and `mcp-server.service.ts`
(wired into `createServer`).

## Adding a tool (required format)

Every tool MUST declare **`title`**, **`description`**, **`inputSchema`**,
**`outputSchema`**, and **`annotations`**. The handler MUST resolve context,
check scope, run inside try/catch, and return via `toolResult` / `safeToolError`.

```typescript
server.registerTool(
  "get_thing",
  {
    title: "Get thing",                 // human-readable display name
    annotations: READ_ONLY,             // from mcp-annotations.ts
    description: "What it does and when to use it (guide the model).",
    inputSchema: {                      // Zod raw shape; {} if no args
      id: z.string().uuid().describe("Thing ID"),
    },
    outputSchema: getThingOutput,       // from tool-output-schemas.ts
  },
  async (args, extra) => {
    const ctx = resolve(extra.sessionId);
    if (!ctx) return toolError("No user context");
    const check = requireScope(ctx.scopes, "read");
    if (check.error) return check.result;
    try {
      const data = await this.thingService.getLlmThing(ctx.userId, args.id);
      return toolResult(data);
    } catch (err: unknown) {
      return safeToolError(err);        // never leak 5xx internals
    }
  },
);
```

Checklist for a new tool:

1. Put the data logic on the **domain service** (e.g. `getLlm*`), not in the
   tool. The tool is a thin adapter. Per the repo rule, the same logic is shared
   with the AI Assistant tool executor and both must return the same shape -- wire
   both surfaces in the same PR.
2. Add the tool to its domain `tools/*.tool.ts` with the five config fields above.
3. Add its output schema to `tool-output-schemas.ts` (see conventions below) and
   import it.
4. Pick the right annotation preset (below) and import it.
5. If it mutates data, derive scope `"write"` and enforce the daily write limit
   via `McpWriteLimiter` (see `transactions.tool.ts`). `whitelist`-style
   sanitize user strings with `stripHtml(...)` before persisting. Gate the write
   behind a user confirmation with `confirmWrite(server, message, extra.requestId)`
   (the MCP-elicitation equivalent of the AI Assistant's approve/reject card --
   pass `extra.requestId` so the elicitation is delivered on the tool call's own
   Streamable HTTP SSE stream rather than the standalone GET stream) and
   only persist on `"accepted"`/`"unsupported"`; on `"declined"` return a
   `toolError` without writing. `"unsupported"` means the client can't show a
   dialog -- it still gates every tool call with its own approval prompt, so
   proceeding is not a consent bypass.
   - **Relay first.** When the call is serving a prompt the user typed in the
     Monize web chat (reverse relay), confirm there instead of in the agent's
     MCP client: build the signed `PendingAiAction` with `AiActionBuilderService`
     (shared with the AI Assistant tool executor) and call
     `AiRelayService.emitPendingAction(userId, action)`. If it returns `true`,
     the approve/reject card is shown in the browser and committed via
     `/ai/actions/confirm` on approval -- return `RELAY_PREVIEW_SHOWN` and do
     NOT write or `confirmWrite`. If it returns `false` (no in-flight relay
     prompt), fall through to `confirmWrite` as above.
6. Update `mcp-server.service.ts` count and `mcp.module.ts` if it's a new
   provider class.
7. Add/extend tests (below). `mcp-annotations.spec.ts` enforces that every tool
   has title + input/output schema + annotations and the right read/write hints,
   so bump `EXPECTED_TOOL_COUNT` and `WRITE_TOOLS`/`IDEMPOTENT_WRITES` there.

## `toolResult` and structured content

`toolResult(data)` (in `mcp-context.ts`) is the only success path. It:

- sanitizes every string in the payload (`sanitizeToolResultStrings`),
- emits a text `content` block with the pretty-printed JSON (the raw data shape,
  which the AI Assistant relies on -- do not change it), and
- emits `structuredContent`: objects pass through; **bare arrays are wrapped
  under `items`**; primitives under `value`.

Because every tool declares `outputSchema`, the SDK **requires** `structuredContent`
and validates it against the schema on each call (errors via `toolError`/`safeToolError`
set `isError` and bypass validation). So a tool's output schema must accept what
`toolResult` produces for that tool.

## Output schema conventions (`tool-output-schemas.ts`)

Each export is a **Zod raw shape** (same form as `inputSchema`), not a `z.object`.
Schemas are deliberately **tolerant** so they document shape without rejecting
real runtime data:

- Build every object with the shared `looseObject(...)` helper, never bare
  `z.object(...)`. Tools return entity payloads carrying fields beyond the
  modeled subset (timestamps, foreign keys, relations). The SDK serializes each
  schema to JSON Schema in **output mode** for `tools/list`, where a default
  (strip) object becomes `additionalProperties: false` and the client rejects
  the extra fields with an output-validation error. `looseObject` emits
  `additionalProperties: {}`. (The server validates with Zod, which strips
  unknown keys, so the strictness only bites on the client -- which is why it is
  easy to miss.) Only model the fields you actually expose.
- Money/decimals are numbers at runtime (entity `numericTransformer`). Use the
  shared `num` (`z.number().nullable()`). A divide-by-zero percentage is `NaN`
  at runtime, which `toolResult` normalizes to `null` (NaN's JSON form). Do
  **not** use `z.nan()` in a schema: the SDK's JSON Schema serialization throws
  "NaN cannot be represented in JSON Schema", which fails the entire
  `tools/list` response and leaves every client showing zero tools.
- Use `.nullable()` for documented-null fields and `.optional()` for fields that
  may be absent (including alternate result branches, e.g. dry-run vs created,
  or success vs not-found error payloads -- make all branch fields optional).
- Array-returning tools must wrap under `items`: `{ items: z.array(itemSchema) }`,
  matching `toolResult`'s array wrapping.

## Annotation presets (`mcp-annotations.ts`)

All tools operate on the user's own closed dataset, so `openWorldHint` is always
`false`. Pick by effect:

| Preset | Use for | Hints |
|--------|---------|-------|
| `READ_ONLY` | queries/aggregations/`calculate` | `readOnlyHint: true` |
| `CREATE` | adds a new record | `readOnlyHint:false, destructiveHint:false, idempotentHint:false` |
| `UPDATE` | sets fields to given values | `readOnlyHint:false, destructiveHint:false, idempotentHint:true` |

There is no destructive preset -- no tool deletes data. Add one only if a
delete/overwrite tool is introduced.

## Scopes

`requireScope(ctx.scopes, ...)` gates each handler. Scopes in use: `read`
(queries), `reports` (report/anomaly tools), `write` (mutations). Resources gate
with `hasScope(ctx.scopes, "read")`.

## Resources & prompts

- **Resources** (`registerResource`): give a `title` + `description`, return
  `contents[]` with `mimeType: "application/json"` and the JSON `text`. Same
  context-resolve + `hasScope` check; on error return a `contents` entry with an
  `Error: ...` text rather than throwing.
- **Prompts** (`registerPrompt`): give a `title` + `description` + `argsSchema`
  (Zod raw shape of optional args), and return `messages[]`. Prompts are
  templates only -- no data access, no scope check.

## Security (do not regress)

- `userId` is always from the session context, never from tool args.
- Sanitize user-controlled strings written back: `stripHtml()` before persist,
  and `toolResult` runs `sanitizeToolResultStrings` on all outgoing strings.
- `safeToolError` passes through 4xx messages but returns a generic message for
  5xx/unknown errors -- never leak internals.
- Transport is bearer-only and `@SkipCsrf()`; do not add cookie auth here.

## Testing

Tools/resources/prompts unit tests mock `registerTool`/`registerResource`/
`registerPrompt` to capture the handler, then drive it with a mocked service and
assert on `result.content[0].text` (parsed JSON) and `result.isError`. Plus:

- `mcp-annotations.spec.ts` -- every tool has title + input/output schema +
  annotations with correct read/write hints (update its constants when adding a tool).
- `tool-output-schemas.spec.ts` -- each output schema accepts a representative
  `toolResult` payload (incl. NaN, null, and alternate branches), and an
  end-to-end round-trip through the real SDK via `InMemoryTransport`.
- `mcp-server.service.spec.ts` -- registration counts and that the advertised
  version tracks `package.json`.

## Spec compliance notes

Implemented: Streamable HTTP transport, session management, OAuth 2.1 + RFC 9728
protected-resource metadata, tools (title/description/input+output schema/
annotations), resources (title/description/mimeType), prompts
(title/description/arguments), logging/tools/resources/prompts capabilities.

Intentionally not implemented: `completions` (argument autocompletion) and
resource `subscribe`/`listChanged`. DNS-rebinding protection on the transport is
omitted because auth is bearer-only (no ambient browser credentials to steal).
Add these if a client need arises.
