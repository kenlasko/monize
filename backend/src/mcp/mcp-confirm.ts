import { createHash } from "crypto";
import { Logger } from "@nestjs/common";
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { canonicalize } from "../ai/actions/ai-action-signing.service";
import {
  AI_ACTION_ENVELOPE_FIELDS,
  AI_ACTION_TYPES,
  type AiActionType,
} from "../ai/actions/ai-action.types";
import {
  clientAnsweredForItself,
  elicitationUnanswered,
  elicitationBehaviour,
  recordElicitationAnswered,
  recordElicitationSilent,
  recordElicitationUnanswered,
} from "./mcp-elicitation-support";
// Call-time use only, so the cycle with mcp-context (which reads the errors
// above) never sees a half-loaded module.
import { resolveUserContext } from "./mcp-context";
import type {
  McpConfirmState,
  McpRequestStateCodec,
} from "./mcp-request-state";

export type WriteConfirmation = "accepted" | "declined" | "unsupported";

/**
 * What a write tool does about one confirmation.
 *
 * `ask` is the 2026-07-28 shape: there is no server-side wait on that revision,
 * so the tool RETURNS the question and the client calls it again with the
 * answer. The tool's job is to return `outcome.ask` untouched and write
 * nothing; the second call re-derives the same items and reads the answers.
 */
export type ConfirmOutcome = WriteConfirmation | { ask: InputRequiredResult };

/**
 * Whether a confirmation is still a question. Generic over the outcome union so
 * a caller that adds its own cases (the tools' "relay") can use the one
 * predicate rather than a second hand-rolled check.
 */
export function isAsk<T>(
  outcome: T | { ask: InputRequiredResult },
): outcome is { ask: InputRequiredResult } {
  return typeof outcome === "object" && outcome !== null && "ask" in outcome;
}

/** One thing a user is asked to approve. */
export interface ConfirmItem {
  /** Stable within the round; the key the answer comes back under. */
  key: string;
  /** What the user reads. */
  message: string;
  /**
   * The action this approval is for, canonicalized into the sealed state so
   * the round that writes can prove it is writing what was approved.
   *
   * Pass the signed action descriptor as it is: the fields that vary between
   * rounds are stripped centrally by `roundStableAction`, because a caller
   * that had to remember to strip them is a caller that will forget.
   */
  action: unknown;
}

/**
 * The key one card's answer comes back under, in a round that asks about
 * several. Positional rather than an action id, because an action id is minted
 * per round and would differ between the round that asks and the round that
 * answers -- the fingerprint is what proves the cards are the same ones.
 */
export function cardKey(index: number): string {
  return `card-${index}`;
}

/**
 * The retry round asked about a different change from the one the user
 * approved. Nothing is written; the tool reports it and the model starts over.
 */
export class ConfirmMismatchError extends Error {
  constructor() {
    super(
      "The confirmation no longer matches the change. Call the tool again to get a fresh confirmation.",
    );
    this.name = "ConfirmMismatchError";
  }
}

/**
 * A deletion or a multi-row write that no human confirmed. Nothing is written;
 * the tool reports it and the model tells the user where the change can be
 * approved instead.
 *
 * "unsupported" -- a client that declared no elicitation, or never answered it
 * -- means no dialog reached a human, so for the changes that destroy data or
 * touch many rows at once it refuses rather than falls through. This protects
 * users of clients that cannot show a confirmation dialog; it is not a defence
 * against a stolen bearer, whose caller can declare elicitation and accept its
 * own dialog (that belongs to the credential layer: scopes, grant notifications).
 */
export class ConfirmRequiredError extends Error {
  constructor() {
    super(
      "Not changed: deleting, or changing several items at once, needs a confirmation dialog, and this MCP client did not show one. Ask the user to make this change in the Monize web chat or in Monize itself, or to use an MCP client that shows confirmation dialogs.",
    );
    this.name = "ConfirmRequiredError";
  }
}

/**
 * A dialog was shown (or sent) and nobody answered it in time, or the
 * connection ended while it was open. Nothing is written. This is not
 * evidence that the client cannot show dialogs, so the session is not marked
 * silent and a later write is asked again.
 */
export class ConfirmNotAnsweredError extends Error {
  constructor() {
    super(
      "Not changed: the confirmation was not answered in time. Ask the user to make the change again and to answer the confirmation dialog when it appears. If no dialog appears, make the change in the Monize web chat or in Monize itself.",
    );
    this.name = "ConfirmNotAnsweredError";
  }
}

/** Action types that write many rows from one card. */
const BULK_ACTION_TYPES: ReadonlySet<AiActionType> = new Set<AiActionType>([
  "batch_actions",
  "create_transactions",
  "create_investment_transactions",
  "run_transaction_rule",
]);

/** Single-row action types a tool may confirm: the AI actions and the one MCP-only write. */
const SINGLE_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  ...AI_ACTION_TYPES,
  "enter_bond_series_manually",
]);

function actionType(action: unknown): string | undefined {
  const type = (action as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Whether a round may write only on a human's answer: more than one action
 * card, a deletion (any `delete_*` action, so a new one is covered without a
 * list edit), or a card that writes many rows.
 *
 * Fails closed: an action that is missing, has no string `type` or has a type
 * this server does not know is not a single create or edit, so it needs an
 * answer too. An array counts one card per element.
 */
export function needsHumanAnswer(items: readonly ConfirmItem[]): boolean {
  const cards = actionCards(items);
  return (
    cards.length !== 1 ||
    cards.some((card) => {
      const type = actionType(card);
      return (
        type === undefined ||
        !SINGLE_ACTION_TYPES.has(type) ||
        type.startsWith("delete_") ||
        (BULK_ACTION_TYPES.has(type as AiActionType) &&
          !isOneRowNonDeleteCard(card))
      );
    })
  );
}

/** The cards of a round: an array action counts one card per element. */
function actionCards(items: readonly ConfirmItem[]): unknown[] {
  return items.flatMap((item) =>
    Array.isArray(item.action) ? item.action : [item.action],
  );
}

/**
 * A `batch_actions`, `create_transactions` or `create_investment_transactions`
 * card that holds exactly one row and does not delete is a single create or
 * edit (a bulk tool with one row left after skips). Anything else about the
 * card's shape stays bulk, so a malformed one fails closed.
 */
function isOneRowNonDeleteCard(card: unknown): boolean {
  const { type, operation, rows } = card as {
    type?: unknown;
    operation?: unknown;
    rows?: unknown;
  };
  return (
    (type === "create_transactions" ||
      type === "create_investment_transactions" ||
      (type === "batch_actions" &&
        typeof operation === "string" &&
        !operation.startsWith("delete"))) &&
    Array.isArray(rows) &&
    rows.length === 1
  );
}

const logger = new Logger("McpConfirm");

/**
 * The policy for a round in which no dialog reached a human: refuse a deletion
 * or a multi-row write, let a single create or edit through, and log either
 * case with a stable marker so an operator can tell a write nobody answered
 * for from one a person approved.
 */
function applyUnconfirmedPolicy(
  ctx: ServerContext,
  items: readonly ConfirmItem[],
  answers: Map<string, WriteConfirmation>,
): void {
  if (![...answers.values()].includes("unsupported")) return;
  const refused = needsHumanAnswer(items);
  logUnconfirmed(ctx, items, refused);
  if (refused) throw new ConfirmRequiredError();
}

function logUnconfirmed(
  ctx: ServerContext,
  items: readonly ConfirmItem[],
  refused: boolean,
): void {
  const user = resolveUserContext(ctx);
  logger.warn(
    `mcp-unconfirmed-write outcome=${refused ? "refused" : "allowed"} user=${user?.userId ?? "unknown"} credential=${user?.credentialId ?? "unknown"} actions=${actionCards(
      items,
    )
      .map((card) => actionType(card) ?? "unknown")
      .join(",")}`,
  );
}

/**
 * How long the confirmation dialog may stay unanswered on a 2025-era
 * connection.
 *
 * A human needs time to read and decide, so this overrides the SDK's short
 * default request timeout -- but it must still expire BEFORE the client gives
 * up on the `tools/call` that is waiting for it. Claude's MCP tool deadline is
 * 60s, and the previous five-minute wait meant a client that never answers the
 * elicitation produced no result at all: the tool call died at the client's own
 * deadline with an opaque "timed out after 60s", no write and no explanation.
 * Staying under the client deadline is what makes every branch below reportable.
 *
 * A 2026-07-28 request has no server-side wait at all -- the server returns and
 * the client calls again -- so the human's window there is the sealed state's
 * own TTL (`McpRequestStateCodec`), which is ten minutes.
 */
export const CONFIRM_TIMEOUT_MS = 45 * 1000;

/**
 * The codec that seals a confirmation, installed per server by `createServer`.
 *
 * Keyed weakly on the `McpServer` for the same reason the elicitation-behaviour
 * record is: it belongs to that server and dies with it, with no cleanup hook
 * to forget.
 */
const codecs = new WeakMap<McpServer, McpRequestStateCodec>();

export function installConfirmSupport(
  server: McpServer,
  codec: McpRequestStateCodec,
): void {
  codecs.set(server, codec);
}

/**
 * Fields an action carries that are minted per BUILD rather than describing the
 * change, so two derivations of the same change disagree on them.
 *
 * The two rounds of a 2026-07-28 confirmation are two separate tool calls, and
 * each one rebuilds its descriptor: `actionId` is a fresh UUID, `expiresAt` a
 * fresh clock reading, `attachmentRefId` a fresh parking slot for bytes that
 * are otherwise identified by `sha256`, `filename`, `contentType` and
 * `byteSize` -- all of which stay in the fingerprint. Hashing any of them would
 * make every retry a mismatch and refuse every confirmed write.
 *
 * The envelope half is not restated here: it comes from the descriptor's own
 * declaration (`AI_ACTION_ENVELOPE_FIELDS`), whose type makes the compiler
 * refuse a new per-build field that is not on the list.
 */
const ROUND_VOLATILE_ACTION_FIELDS: ReadonlySet<string> = new Set<string>([
  ...AI_ACTION_ENVELOPE_FIELDS,
  // Derived from the descriptor, so it varies with it.
  "signature",
  // The parking slot, not the file: sha256/filename/contentType/byteSize stay.
  "attachmentRefId",
]);

/**
 * The part of an action that says WHAT is being approved, with the per-build
 * fields removed at every depth (a batch descriptor nests rows, and a row can
 * nest attachments).
 *
 * Exported for the guard that drives the real action builder twice and asserts
 * the projection is identical; nothing else should need it.
 */
export function roundStableAction(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(roundStableAction);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const stable: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (ROUND_VOLATILE_ACTION_FIELDS.has(key)) continue;
    stable[key] = roundStableAction(nested);
  }
  return stable;
}

/**
 * Hash of the exact set of actions a user is being asked to approve.
 *
 * The keys and messages are in it as well as the actions: a retry that asks the
 * same rows under different wording, or in a different order, is not the
 * confirmation that was given. The actions go in through `roundStableAction`,
 * so what is hashed is the change and not the round it was built in.
 */
export function confirmationFingerprint(items: ConfirmItem[]): string {
  return createHash("sha256")
    .update(
      canonicalize(
        items.map((item) => ({
          key: item.key,
          message: item.message,
          action: roundStableAction(item.action),
        })),
      ),
    )
    .digest("hex");
}

/**
 * One confirmation item per approval card, keyed by position within the round.
 *
 * Every write tool asks the same question of a list of `PendingAiAction`s, and
 * three copies of this mapping is three places for the action passed to the
 * fingerprint to drift from the descriptor that is actually committed.
 */
export function confirmItemsForCards<T extends { descriptor: unknown }>(
  cards: readonly T[],
  lineFor: (card: T) => string,
): ConfirmItem[] {
  return cards.map((card, index) => ({
    key: cardKey(index),
    message: lineFor(card),
    action: card.descriptor,
  }));
}

/** Whether this request is a 2026-07-28 one (it carries the `_meta` envelope). */
function isModern(ctx: ServerContext): boolean {
  return ctx.mcpReq.envelope !== undefined;
}

/**
 * What the client said it can do, from this request's own envelope.
 *
 * Read before returning an `inputRequired`, because the SDK answers a client
 * that declared no elicitation with a protocol error (-32021) -- which would
 * fail the whole tool call instead of falling through to the client's own
 * approval prompt, the only consent step such a client has.
 */
function declaredCapabilities(
  server: McpServer,
  ctx: ServerContext,
): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  if (declared && typeof declared === "object") {
    return declared as ClientCapabilities;
  }
  return server.server.getClientCapabilities();
}

/**
 * Ask the MCP client to confirm one write. See `confirmWriteMany`, which this
 * wraps -- a single item is the common case, not a different mechanism.
 */
export async function confirmWrite(
  server: McpServer,
  ctx: ServerContext,
  message: string,
  action?: unknown,
): Promise<ConfirmOutcome> {
  const outcome = await confirmWriteMany(server, ctx, [
    { key: "confirm", message, action },
  ]);
  if (outcome instanceof Map) {
    return outcome.get("confirm") ?? "declined";
  }
  return outcome;
}

/**
 * Ask the MCP client to confirm a set of writes -- the MCP-native equivalent of
 * the AI Assistant's approve/reject cards. Each item answers:
 *  - "accepted": the user approved; proceed with that write.
 *  - "declined": the user answered and the answer was no (reject/cancel), or
 *    the dialog failed in a way we cannot account for; abort, so a write never
 *    happens over a user's refusal.
 *  - "unsupported": no dialog reached a human, so the caller falls back to its
 *    normal behavior, relying on the client's own per-tool approval prompt.
 *    That prompt is only as honest as the client, so this outcome is returned
 *    only for a single create or edit: a round that deletes or writes several
 *    rows throws `ConfirmRequiredError` instead (`needsHumanAnswer`), and every
 *    unconfirmed round is logged as `mcp-unconfirmed-write`.
 *
 * **On 2026-07-28 the answer arrives on a later call, not from a wait.** Round
 * one returns `{ ask }` carrying a sealed `requestState`; the client shows the
 * dialogs and calls the tool again with the answers. Round two re-derives the
 * items from the same arguments, checks them against the fingerprint the user
 * approved, and reads the answers. Everything the second round needs travels in
 * the result and comes back -- the server holds nothing in between, which is
 * what makes the endpoint stateless.
 *
 * **On a 2025-era connection the server asks and waits**, exactly as before,
 * because that revision has server-initiated requests and the SDK's own
 * shim is deliberately off (`legacyShim: false`): our fallback for a client
 * that cannot show a dialog is behavioural, and a shim cannot reproduce it.
 *
 * **The advertised capability is not evidence that a dialog can be shown.**
 * The SDK normalizes the legacy 2025-06-18 shape `{"elicitation":{}}` into
 * `{"elicitation":{"form":{}}}` before `getClientCapabilities()` ever sees it,
 * so `elicitation.form` is truthy for every client that advertises elicitation
 * at all -- including the ones that answer -32601 to `elicitation/create`, and
 * the ones that never answer it. That was the whole regression: those clients
 * looked form-capable, so a failure to answer was read as the user saying no
 * and every write through Claude was refused or hung until the client's own
 * deadline. `mcp-confirm.spec.ts` pins the normalization so this cannot
 * silently flip back into a load-bearing check.
 *
 * So the *outcome* carries the weight, not the capability: only a returned
 * `action` is a user's answer. The pre-check is kept because a client
 * advertising no elicitation at all still deserves to skip the round trip.
 *
 * `server` is the session's (or the request's) `McpServer`, which every tool's
 * `register` closure already holds. It carries the client's advertised
 * capabilities, the per-session record of what that client does with a dialog,
 * and the codec that seals a multi-round confirmation.
 */
export async function confirmWriteMany(
  server: McpServer,
  ctx: ServerContext,
  items: ConfirmItem[],
): Promise<{ ask: InputRequiredResult } | Map<string, WriteConfirmation>> {
  if (items.length === 0) return new Map();
  const outcome = isModern(ctx)
    ? await confirmModern(server, ctx, items)
    : await confirmLegacy(server, ctx, items);
  if (outcome instanceof Map) applyUnconfirmedPolicy(ctx, items, outcome);
  return outcome;
}

/** 2026-07-28: return the question, or read the answers to it. */
async function confirmModern(
  server: McpServer,
  ctx: ServerContext,
  items: ConfirmItem[],
): Promise<{ ask: InputRequiredResult } | Map<string, WriteConfirmation>> {
  const state = ctx.mcpReq.requestState<McpConfirmState>();

  if (!state) {
    if (!declaredCapabilities(server, ctx)?.elicitation?.form) {
      return new Map(items.map((item) => [item.key, "unsupported" as const]));
    }
    const codec = codecs.get(server);
    if (!codec) {
      // Nothing can seal the round trip, so nothing may be asked over it:
      // an unsealed state is attacker-controlled input.
      return new Map(items.map((item) => [item.key, "declined" as const]));
    }
    const requestState = await codec.mint(
      {
        v: 1,
        keys: items.map((item) => item.key),
        fingerprint: confirmationFingerprint(items),
      },
      ctx,
    );
    return {
      ask: inputRequired({
        requestState,
        inputRequests: Object.fromEntries(
          items.map((item) => [
            item.key,
            inputRequired.elicit({
              message: item.message,
              // No fields to collect -- accept/decline/cancel is the answer.
              requestedSchema: { type: "object", properties: {} },
            }),
          ]),
        ),
      }),
    };
  }

  // The seam has already proven the state's MAC, expiry and binding, so what is
  // left is whether it is about THIS change: a retry that re-derived different
  // rows (a name that now resolves elsewhere, an amount the model altered) is
  // not the confirmation the user gave.
  const keys = items.map((item) => item.key);
  if (
    state.keys.length !== keys.length ||
    state.keys.some((key, index) => key !== keys[index]) ||
    state.fingerprint !== confirmationFingerprint(items)
  ) {
    throw new ConfirmMismatchError();
  }

  return new Map(
    items.map((item) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, item.key);
      // Anything that is not an accepted elicitation refuses the write:
      // declined, cancelled, missing, dropped, or a response of another kind.
      const answer: WriteConfirmation =
        view.kind === "elicit" && view.action === "accept"
          ? "accepted"
          : "declined";
      return [item.key, answer];
    }),
  );
}

/** 2025-era: ask the client and wait, one item at a time. */
async function confirmLegacy(
  server: McpServer,
  ctx: ServerContext,
  items: ConfirmItem[],
): Promise<Map<string, WriteConfirmation>> {
  const answers = new Map<string, WriteConfirmation>();
  const needsHuman = needsHumanAnswer(items);
  for (const item of items) {
    answers.set(
      item.key,
      await confirmLegacyOne(server, ctx, item.message, items, needsHuman),
    );
  }
  return answers;
}

async function confirmLegacyOne(
  server: McpServer,
  ctx: ServerContext,
  message: string,
  items: readonly ConfirmItem[],
  needsHuman: boolean,
): Promise<WriteConfirmation> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation?.form) {
    return "unsupported";
  }
  // A client already caught answering for itself is not asked again: on a
  // client that drops the request, the round trip costs CONFIRM_TIMEOUT_MS
  // every time, which on a 25-row individual batch is the same paralysis in
  // slow motion.
  const behaviour = elicitationBehaviour(server);
  if (behaviour === "silent") {
    return "unsupported";
  }
  // A dialog went unanswered earlier: a single create or edit does not wait
  // for another, but a round that needs a human still asks.
  if (behaviour === "unanswered" && !needsHuman) {
    return "unsupported";
  }
  try {
    const result = await ctx.mcpReq.elicitInput(
      {
        message,
        // No fields to collect -- the accept/decline/cancel action is the answer.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout: CONFIRM_TIMEOUT_MS },
    );
    recordElicitationAnswered(server);
    return result.action === "accept" ? "accepted" : "declined";
  } catch (err) {
    const unanswered = elicitationUnanswered(err);
    if (!unanswered && !clientAnsweredForItself(err)) {
      return "declined";
    }
    // A client that has already shown a dialog in this session can show
    // another, so this failure is one unanswered dialog, not a client with no
    // human behind it -- refuse rather than fall through to the write.
    if (elicitationBehaviour(server) === "answers") {
      return "declined";
    }
    // An unanswered dialog does not show the client cannot show one. A round
    // that needs a human is refused for this one write and asked again next
    // time. A single create or edit falls through to the client's own prompt,
    // and the session is marked "unanswered" so it is not waited on for
    // CONFIRM_TIMEOUT_MS again.
    if (unanswered) {
      if (needsHuman) {
        logUnconfirmed(ctx, items, true);
        throw new ConfirmNotAnsweredError();
      }
      recordElicitationUnanswered(server);
      return "unsupported";
    }
    recordElicitationSilent(server);
    return "unsupported";
  }
}
