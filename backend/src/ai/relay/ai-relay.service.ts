import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  RelayAttachmentRef,
  RelayClaimedPrompt,
  RelayResponse,
  RelayServerEvent,
  RelayTunnelState,
  RelayTunnelStatus,
} from "./ai-relay.types";
import { RelayAttachmentStore } from "./relay-attachment.store";
import { AttachmentDto } from "../query/dto/ai-query.dto";
import { PendingAiAction } from "../actions/ai-action.types";

/**
 * How long a queued (never-claimed) prompt waits for ANY agent to pick it up
 * before the browser gives up. Keeps an offline agent from hanging the browser
 * forever. This is the only deadline that applies before a claim; once an agent
 * claims the prompt the idle timer below takes over.
 */
const QUEUE_WAIT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Once an agent has claimed a prompt, how long it may go completely silent (no
 * poll, progress, or tool activity) before the browser gives up on it. Reset by
 * every liveness signal, so a slow-but-alive agent that keeps reporting stays
 * connected indefinitely (up to HARD_WAIT_MS). A blip in the agent's own API
 * connection is what trips this -- and the late-answer buffer still preserves
 * the answer if the agent recovers and posts late.
 *
 * Sized to outlast the agent's own quiet phases: composing a large tool-call
 * payload (e.g. a 40-item bulk write) is invisible to us -- no poll, progress,
 * or tool activity reaches the relay until the call lands -- so too short a
 * window trips mid-composition, the browser gives up, and a confirmation card
 * emitted afterwards has no live stream to render into (#793). The card buffer
 * recovers that case regardless, but a generous idle window keeps the common
 * case on the live stream so the card appears without a pickup round-trip.
 */
const IDLE_TIMEOUT_MS = 180 * 1000; // 3 minutes of silence after a claim

/**
 * Absolute backstop from claim time, regardless of liveness, so a wedged agent
 * that keeps emitting heartbeats but never finishes cannot hold the browser
 * open forever.
 */
const HARD_WAIT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * How long a late answer (one posted after the browser stream already gave up
 * or disconnected) is retained so the browser can pick it up via the pickup
 * endpoint. Pruned after this.
 */
const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Cap on buffered late answers retained per user. Bounds memory if an agent
 * keeps answering prompts whose browsers have all gone away. Oldest entries are
 * evicted first.
 */
const MAX_BUFFERED_PER_USER = 20;

/**
 * How long a single `get_next_prompt` long-poll parks before returning empty.
 * Kept under typical proxy idle timeouts; the agent is told to immediately poll
 * again, so this just bounds one HTTP round-trip.
 */
const POLL_PARK_MS = 25 * 1000; // 25 seconds

/**
 * An agent counts as "connected" if it polled within this window. Slightly
 * longer than POLL_PARK_MS so the brief gap between two polls does not flicker
 * the indicator back to offline.
 */
const CONNECTED_WINDOW_MS = 45 * 1000; // 45 seconds

/**
 * How long the user can be inactive (no new prompt) before the relay tells the
 * agent to stop its polling loop. An idle agent otherwise long-polls
 * `get_next_prompt` forever, and every empty poll is a fresh turn that bloats
 * the agent's own context until it degrades or its harness gives up mid-task.
 * Stopping the loop cleanly after a quiet spell avoids that; the web chat shows
 * an "idle disconnected" notice and the user reconnects when they want to
 * continue. The clock resets on every prompt, so an active conversation is
 * never interrupted.
 */
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Most recent conversation turns carried into a relayed prompt. The browser
 * sends the whole conversation, but `get_next_prompt` returns it to the agent on
 * EVERY prompt, and the agent runs the relay loop in one long-lived session that
 * also accumulates its own context. Returning an unbounded history therefore
 * grows the agent's context until the model degrades (multi-minute "thinking",
 * malformed tool calls, no answer). Keep only the newest turns, within a char
 * budget, so continuity survives without the bloat.
 */
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 12000;
const HISTORY_TRUNCATION_MARKER = " … [truncated]";

/**
 * Trim a conversation history to the most recent turns within the char budget,
 * preserving order (oldest first). Older turns that do not fit are dropped; if
 * the single newest turn alone exceeds the budget it is kept but truncated, so
 * the result is always bounded regardless of how long the conversation grew.
 */
export function trimRelayHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Array<{ role: "user" | "assistant"; content: string }> {
  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  let budget = MAX_HISTORY_CHARS;
  for (
    let i = history.length - 1;
    i >= 0 && kept.length < MAX_HISTORY_TURNS && budget > 0;
    i--
  ) {
    const { role, content } = history[i];
    if (content.length <= budget) {
      kept.push({ role, content });
      budget -= content.length;
    } else {
      // Only the newest kept turn may be truncated to fit; once anything is
      // kept, an over-budget older turn (and everything before it) is dropped.
      if (kept.length === 0) {
        kept.push({
          role,
          content: content.slice(0, budget) + HISTORY_TRUNCATION_MARKER,
        });
      }
      break;
    }
  }
  return kept.reverse();
}

interface PendingPrompt {
  id: string;
  prompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  resolve: (response: RelayResponse) => void;
  reject: (err: Error) => void;
  /**
   * Browser-side timeout handle; cleared/rescheduled as liveness arrives and
   * cleared once the prompt settles. While the prompt is queued it counts down
   * QUEUE_WAIT_MS; once claimed it becomes the idle timer (IDLE_TIMEOUT_MS),
   * rescheduled by every liveness signal up to the hard deadline.
   */
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** True once an agent has claimed this prompt via get_next_prompt. */
  claimed: boolean;
  /**
   * Refs to attachments the user uploaded with this prompt (bytes live in the
   * RelayAttachmentStore). Passed to the agent on claim and released once the
   * prompt definitively settles; the store's TTL is the backstop.
   */
  attachments: RelayAttachmentRef[];
  /**
   * Absolute backstop (epoch ms) computed at claim time; the idle timer never
   * schedules past this, so a perpetually-chatty-but-stuck agent still loses the
   * browser at HARD_WAIT_MS.
   */
  hardDeadline: number;
  /**
   * Pushes an intermediate SSE event to the browser stream still parked on this
   * prompt. Used to deliver a write-confirmation card (`pending_action`) while
   * the agent is working, so the user approves it in the web chat instead of in
   * their MCP client. Undefined for callers that do not stream (e.g. tests).
   */
  emit?: (event: RelayServerEvent) => void;
}

interface Waiter {
  resolve: (prompt: RelayClaimedPrompt | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A late agent answer held for pickup after the browser stream gave up. */
interface BufferedResponse {
  text: string;
  /** Epoch ms the answer was posted; used for TTL pruning and LRU eviction. */
  at: number;
}

/**
 * A write-confirmation card emitted by an agent after the browser stream had
 * already given up (idle timeout while the agent composed a large tool call).
 * Held for pickup so the user still sees and can approve it -- mirrors the
 * late-answer buffer above, keyed by the action's own id.
 */
interface BufferedAction {
  action: PendingAiAction;
  /** Epoch ms the card was emitted; used for TTL pruning and LRU eviction. */
  at: number;
}

/**
 * In-memory broker between the browser chat and the user's MCP agent.
 *
 * State is per-process (single backend instance): a multi-replica deployment
 * would need a shared backplane (e.g. Redis pub/sub) instead of these maps. The
 * relay never touches financial data itself -- it only routes prompts and
 * answers; the agent does the work through the existing MCP tools.
 */
@Injectable()
export class AiRelayService {
  private readonly logger = new Logger(AiRelayService.name);

  constructor(private readonly attachmentStore: RelayAttachmentStore) {}

  /** Prompts enqueued by the browser, not yet claimed by an agent (FIFO). */
  private readonly pending = new Map<string, PendingPrompt[]>();
  /** Prompts claimed by an agent, awaiting `post_response`, keyed by promptId. */
  private readonly inFlight = new Map<
    string,
    { userId: string; prompt: PendingPrompt }
  >();
  /** Agents parked on `get_next_prompt`, awaiting a prompt to hand off. */
  private readonly waiters = new Map<string, Waiter[]>();
  /** Last time each user's agent polled, for connection liveness. */
  private readonly lastPollAt = new Map<string, number>();
  /**
   * When the current idle (no-prompt) streak began for a user, set on the first
   * empty poll and reset on any prompt. Drives the inactivity disconnect.
   */
  private readonly idleSince = new Map<string, number>();
  /**
   * Users whose agent was told to stop after INACTIVITY_TIMEOUT_MS of no prompts.
   * Surfaced in the tunnel status so the chat shows an "idle disconnected" notice
   * until the user reconnects (the agent polls again) or sends a new prompt.
   */
  private readonly idleDisconnectedAt = new Map<string, number>();
  /**
   * Late answers whose browser stream already gave up or disconnected, keyed by
   * userId then promptId. The browser picks them up via takeBufferedResponse so
   * an agent that recovers from a connection blip never loses its work.
   */
  private readonly buffered = new Map<string, Map<string, BufferedResponse>>();
  /**
   * Prompts that were claimed by an agent and then timed out (idle/hard) before
   * `post_response` arrived, keyed by promptId. Removed from `inFlight` so the
   * tunnel no longer reads "busy", but remembered here (with the owning userId)
   * so a late `post_response` is recognised and buffered instead of dropped.
   * Entries are evicted when the answer arrives, or after BUFFER_TTL_MS since
   * there is no point waiting longer than the buffer would retain the answer.
   */
  private readonly awaitingLate = new Map<
    string,
    { userId: string; at: number }
  >();
  /**
   * Write-confirmation cards emitted after the browser stream gave up, keyed by
   * userId then actionId. The browser drains them via the pickup endpoint so a
   * card composed slowly (idle timeout fired) is still shown and approvable
   * rather than being silently lost or auto-declined (#793).
   */
  private readonly bufferedActions = new Map<
    string,
    Map<string, BufferedAction>
  >();

  /**
   * Enqueue a prompt from the browser and resolve when the agent answers.
   * If an agent is already parked, the prompt is handed off immediately;
   * otherwise it waits in the queue until claimed (or the browser times out).
   *
   * `onEnqueued` (if given) is invoked synchronously with the generated
   * promptId before the promise settles, so the browser stream can tell the
   * client its id up front and later pick up a late answer for it.
   */
  enqueuePrompt(
    userId: string,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    emit?: (event: RelayServerEvent) => void,
    onEnqueued?: (promptId: string) => void,
    attachments?: AttachmentDto[],
  ): Promise<RelayResponse> {
    // Validate and persist any attachments up front so a bad upload rejects the
    // request synchronously (the controller maps the thrown BadRequestException
    // to an error SSE event) before the prompt is ever queued.
    const attachmentRefs = this.attachmentStore.store(
      userId,
      attachments ?? [],
    );
    // A new prompt is activity: restart the inactivity clock and clear any
    // prior idle-disconnect notice so the chat shows the live state again.
    this.idleSince.delete(userId);
    this.idleDisconnectedAt.delete(userId);
    return new Promise<RelayResponse>((resolve, reject) => {
      const entry: PendingPrompt = {
        id: randomUUID(),
        prompt,
        // Bound the history handed to the agent: get_next_prompt returns it on
        // every prompt, so an unbounded conversation bloats the agent's context.
        history: trimRelayHistory(history),
        resolve,
        reject,
        settled: false,
        claimed: false,
        hardDeadline: 0,
        attachments: attachmentRefs,
        emit,
        // Queued prompts count down the queue wait; once an agent claims this
        // prompt, claim() swaps in the idle timer.
        timer: setTimeout(() => {
          this.settleTimeout(userId, entry);
        }, QUEUE_WAIT_MS),
      };

      onEnqueued?.(entry.id);

      const waiter = this.takeWaiter(userId);
      if (waiter) {
        this.handOff(userId, entry, waiter);
        return;
      }

      const queue = this.pending.get(userId) ?? [];
      this.pending.set(userId, [...queue, entry]);
    });
  }

  /**
   * Called by the `get_next_prompt` MCP tool. Returns the next queued prompt
   * for the user, or parks until one arrives or the poll window elapses (then
   * returns null so the agent polls again).
   */
  waitForPrompt(userId: string): Promise<RelayClaimedPrompt | null> {
    this.lastPollAt.set(userId, Date.now());
    // The agent is polling, so it is connected: clear any stale idle-disconnect
    // notice (e.g. it just reconnected after a quiet spell).
    this.idleDisconnectedAt.delete(userId);
    // A poll proves the agent is alive: keep any prompt it is mid-task on from
    // tripping the idle timer.
    this.bumpInFlight(userId);

    const queue = this.pending.get(userId) ?? [];
    const [next, ...rest] = queue;
    if (next) {
      this.pending.set(userId, rest);
      // Claiming a prompt is activity: restart the inactivity clock.
      this.idleSince.delete(userId);
      return Promise.resolve(this.claim(userId, next));
    }

    return new Promise<RelayClaimedPrompt | null>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(userId, waiter);
          resolve(null);
        }, POLL_PARK_MS),
      };
      const list = this.waiters.get(userId) ?? [];
      this.waiters.set(userId, [...list, waiter]);
    });
  }

  /**
   * Called by `get_next_prompt` after an empty poll (no prompt was waiting) to
   * decide whether the agent should stop its loop for inactivity. The first
   * empty poll starts the idle clock; once INACTIVITY_TIMEOUT_MS of no prompts
   * has elapsed it returns true (and records the disconnect so the chat can show
   * it), telling the tool to instruct the agent to exit rather than keep
   * polling. The clock is reset by enqueuePrompt and by claiming a prompt, so an
   * active conversation never trips it.
   */
  shouldStopForIdle(userId: string): boolean {
    const since = this.idleSince.get(userId);
    if (since === undefined) {
      this.idleSince.set(userId, Date.now());
      return false;
    }
    if (Date.now() - since >= INACTIVITY_TIMEOUT_MS) {
      this.idleSince.delete(userId);
      this.idleDisconnectedAt.set(userId, Date.now());
      this.logger.log(
        `Relay agent for user ${userId} idle ${INACTIVITY_TIMEOUT_MS}ms; ` +
          `signalling stop`,
      );
      return true;
    }
    return false;
  }

  /**
   * Called by the `post_response` MCP tool. Delivers the agent's answer to the
   * waiting browser request when one is still parked. If the browser already
   * gave up (idle/hard timeout) or its stream is gone, the answer is NOT
   * dropped: it is buffered for pickup so a recovered agent never loses its
   * work. Returns true whenever the answer was accepted (delivered or buffered)
   * and is idempotent -- a second post for the same promptId is a no-op true.
   *
   * Returns false only for an unknown or foreign promptId (never seen, or it
   * belongs to another user).
   */
  postResponse(userId: string, promptId: string, text: string): boolean {
    this.lastPollAt.set(userId, Date.now());

    const record = this.inFlight.get(promptId);
    if (record && record.userId === userId) {
      this.inFlight.delete(promptId);
      const { prompt } = record;
      // Still parked: deliver straight to the waiting browser stream.
      prompt.settled = true;
      clearTimeout(prompt.timer);
      this.releaseAttachments(userId, prompt);
      prompt.resolve({ text });
      return true;
    }

    // Not in flight. It may have timed out while claimed (the agent's API
    // blipped): preserve the late answer for pickup instead of dropping it.
    const late = this.awaitingLate.get(promptId);
    if (late && late.userId === userId) {
      this.awaitingLate.delete(promptId);
      this.bufferResponse(userId, promptId, text);
      return true;
    }

    // A late answer may already be buffered for this prompt (a duplicate post):
    // keep the first one and treat the repeat as an idempotent no-op success.
    const userBuffer = this.buffered.get(userId);
    if (userBuffer?.has(promptId)) {
      return true;
    }

    // Unknown or foreign promptId, or a duplicate post after the first was
    // delivered to a live stream (no longer tracked anywhere).
    return false;
  }

  /**
   * Hand a buffered late answer to the browser and remove it. Returns null if
   * nothing is buffered for this prompt (expired, already picked up, or never
   * buffered). Prunes expired entries on access.
   */
  takeBufferedResponse(userId: string, promptId: string): RelayResponse | null {
    this.pruneBuffer(userId);
    const userBuffer = this.buffered.get(userId);
    const entry = userBuffer?.get(promptId);
    if (!entry) {
      return null;
    }
    userBuffer!.delete(promptId);
    if (userBuffer!.size === 0) {
      this.buffered.delete(userId);
    }
    return { text: entry.text };
  }

  /** Store a late answer for pickup, enforcing TTL and the per-user cap. */
  private bufferResponse(userId: string, promptId: string, text: string): void {
    this.pruneBuffer(userId);
    const existing =
      this.buffered.get(userId) ?? new Map<string, BufferedResponse>();
    // Build the next map immutably from the existing entries plus this one.
    const next = new Map(existing);
    next.set(promptId, { text, at: Date.now() });
    // Evict oldest entries (by post time) until within the per-user cap.
    if (next.size > MAX_BUFFERED_PER_USER) {
      const ordered = [...next.entries()].sort((a, b) => a[1].at - b[1].at);
      const trimmed = ordered.slice(next.size - MAX_BUFFERED_PER_USER);
      this.buffered.set(userId, new Map(trimmed));
    } else {
      this.buffered.set(userId, next);
    }
    this.logger.warn(
      `Relay prompt ${promptId} for user ${userId} answered late; buffered for pickup`,
    );
  }

  /**
   * Drop late-answer markers older than the buffer TTL: there is no point
   * holding an inFlight-timeout marker longer than the answer would survive once
   * buffered. Keeps the map from growing if agents never return.
   */
  private pruneAwaitingLate(): void {
    const cutoff = Date.now() - BUFFER_TTL_MS;
    for (const [promptId, marker] of this.awaitingLate) {
      if (marker.at < cutoff) {
        this.awaitingLate.delete(promptId);
      }
    }
  }

  /** Drop expired buffered answers for a user; clean up the empty bucket. */
  private pruneBuffer(userId: string): void {
    const userBuffer = this.buffered.get(userId);
    if (!userBuffer) {
      return;
    }
    const cutoff = Date.now() - BUFFER_TTL_MS;
    const live = [...userBuffer.entries()].filter(([, v]) => v.at >= cutoff);
    if (live.length === 0) {
      this.buffered.delete(userId);
    } else if (live.length !== userBuffer.size) {
      this.buffered.set(userId, new Map(live));
    }
  }

  /**
   * Called by the `report_progress` MCP tool. Streams an interim status line
   * from the agent to the browser parked on this prompt as an `assistant_text`
   * event -- the same live-narration channel the native AI Assistant uses -- so
   * the user sees what the agent is doing ("looking up the category...",
   * "sending the confirmation card...") instead of a static spinner. Returns
   * false if the prompt is unknown, already settled, or has no stream.
   */
  reportProgress(userId: string, promptId: string, text: string): boolean {
    this.lastPollAt.set(userId, Date.now());
    // Progress is liveness: keep the idle timer from firing mid-task.
    this.bumpInFlight(userId);
    const record = this.inFlight.get(promptId);
    if (!record || record.userId !== userId) {
      return false;
    }
    const { prompt } = record;
    if (prompt.settled || !prompt.emit) {
      return false;
    }
    // The browser accumulates assistant_text into one live-narration block
    // (rendered whitespace-pre-wrap), so terminate each discrete update with a
    // newline to keep sequential progress lines from running together.
    prompt.emit({ type: "assistant_text", text: `${text}\n` });
    return true;
  }

  /**
   * Emit an interim SSE event to the browser parked on this user's in-flight
   * relay prompt. Returns true if delivered, false if the user has no active
   * prompt (or its stream is gone). Shared by the progress, tool-activity, and
   * pending-action emitters.
   */
  private emitToInFlight(userId: string, event: RelayServerEvent): boolean {
    for (const record of this.inFlight.values()) {
      if (record.userId !== userId) {
        continue;
      }
      const { prompt } = record;
      if (prompt.settled || !prompt.emit) {
        return false;
      }
      prompt.emit(event);
      return true;
    }
    return false;
  }

  /**
   * Stream the agent's tool activity to the browser as `tool_start` /
   * `tool_result` events -- the same channel the native AI Assistant uses to
   * show "Looking up ..." chips. Called by the MCP server's per-call wrapper for
   * every Monize tool the agent invokes while handling a relayed prompt, so the
   * user sees real-time progress without the agent having to narrate explicitly.
   */
  reportToolActivity(
    userId: string,
    toolName: string,
    phase: "start" | "result",
    isError = false,
  ): void {
    this.lastPollAt.set(userId, Date.now());
    // Tool activity is liveness: keep the idle timer from firing mid-task.
    this.bumpInFlight(userId);
    const event: RelayServerEvent =
      phase === "start"
        ? { type: "tool_start", name: toolName }
        : { type: "tool_result", name: toolName, isError };
    this.emitToInFlight(userId, event);
  }

  /**
   * Push a write-confirmation card to the browser parked on this user's
   * in-flight relay prompt. Called by the MCP write tools when they detect they
   * are serving a relayed prompt: instead of an MCP-client elicitation (which
   * the user would have to accept in their CLI), the approve/reject card is
   * rendered in the web chat, exactly like the native AI Assistant.
   *
   * Returns true when the card was handled by the relay (the caller is in relay
   * context and must NOT perform the write -- the browser commits it via
   * /ai/actions/confirm on approval): either delivered live, or, when the
   * browser stream already gave up while the agent composed the call, buffered
   * for pickup. Returns false only when the user has no relay turn at all (a
   * direct MCP client), so the caller falls back to its own confirmation.
   *
   * Buffering the card when the stream is gone is what fixes #793: previously a
   * card emitted after the idle timeout returned false, the write tool fell
   * through to an MCP-client elicitation the web-chat user could not answer, and
   * it surfaced as a decline.
   */
  emitPendingAction(userId: string, action: PendingAiAction): boolean {
    if (this.emitToInFlight(userId, { type: "pending_action", action })) {
      return true;
    }
    // No live stream. If the user has a relay turn in progress (or one that just
    // timed out), the stream was almost certainly killed by the idle timeout
    // while the agent composed this call -- buffer the card for pickup rather
    // than telling the caller this is not a relay context.
    if (this.hasRelayTurn(userId)) {
      this.bufferAction(userId, action);
      return true;
    }
    return false;
  }

  /**
   * Drain any buffered confirmation cards for a user, removing them. Returns an
   * empty array when none are buffered (expired, already picked up, or never
   * buffered). Prunes expired entries on access.
   */
  takeBufferedActions(userId: string): PendingAiAction[] {
    this.pruneActionBuffer(userId);
    const userBuffer = this.bufferedActions.get(userId);
    if (!userBuffer || userBuffer.size === 0) {
      return [];
    }
    const actions = [...userBuffer.values()]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.action);
    this.bufferedActions.delete(userId);
    return actions;
  }

  /**
   * Whether the user has a relay agent currently or very recently handling a
   * prompt: an in-flight prompt, a prompt that timed out after a claim (awaiting
   * a late answer), or an agent that polled within the connection window. Used
   * to decide whether a card with no live stream belongs to a relay turn (buffer
   * it) or to a direct MCP client (let the caller elicit).
   */
  private hasRelayTurn(userId: string): boolean {
    for (const record of this.inFlight.values()) {
      if (record.userId === userId) {
        return true;
      }
    }
    for (const marker of this.awaitingLate.values()) {
      if (marker.userId === userId) {
        return true;
      }
    }
    const last = this.lastPollAt.get(userId) ?? 0;
    return Date.now() - last < CONNECTED_WINDOW_MS;
  }

  /** Store a late confirmation card for pickup, enforcing TTL and the per-user cap. */
  private bufferAction(userId: string, action: PendingAiAction): void {
    this.pruneActionBuffer(userId);
    const existing =
      this.bufferedActions.get(userId) ?? new Map<string, BufferedAction>();
    const next = new Map(existing);
    next.set(action.actionId, { action, at: Date.now() });
    // Evict oldest entries (by emit time) until within the per-user cap.
    if (next.size > MAX_BUFFERED_PER_USER) {
      const ordered = [...next.entries()].sort((a, b) => a[1].at - b[1].at);
      const trimmed = ordered.slice(next.size - MAX_BUFFERED_PER_USER);
      this.bufferedActions.set(userId, new Map(trimmed));
    } else {
      this.bufferedActions.set(userId, next);
    }
    this.logger.warn(
      `Relay confirmation card ${action.actionId} for user ${userId} emitted ` +
        `after the stream gave up; buffered for pickup`,
    );
  }

  /** Drop expired buffered cards for a user; clean up the empty bucket. */
  private pruneActionBuffer(userId: string): void {
    const userBuffer = this.bufferedActions.get(userId);
    if (!userBuffer) {
      return;
    }
    const cutoff = Date.now() - BUFFER_TTL_MS;
    const live = [...userBuffer.entries()].filter(([, v]) => v.at >= cutoff);
    if (live.length === 0) {
      this.bufferedActions.delete(userId);
    } else if (live.length !== userBuffer.size) {
      this.bufferedActions.set(userId, new Map(live));
    }
  }

  /** Tunnel status for the chat indicator. */
  getStatus(userId: string): RelayTunnelStatus {
    return {
      state: this.computeState(userId),
      queued: (this.pending.get(userId) ?? []).length,
      // Present only between an inactivity stop and the user reconnecting (agent
      // polls again) or sending a new prompt, so the chat can explain it.
      ...(this.idleDisconnectedAt.has(userId)
        ? { idleDisconnected: true }
        : {}),
    };
  }

  private computeState(userId: string): RelayTunnelState {
    const hasInFlight = [...this.inFlight.values()].some(
      (r) => r.userId === userId,
    );
    if (hasInFlight) {
      return "busy";
    }
    const parked = (this.waiters.get(userId) ?? []).length > 0;
    const last = this.lastPollAt.get(userId) ?? 0;
    const recent = Date.now() - last < CONNECTED_WINDOW_MS;
    return parked || recent ? "listening" : "offline";
  }

  private claim(userId: string, entry: PendingPrompt): RelayClaimedPrompt {
    this.inFlight.set(entry.id, { userId, prompt: entry });
    // The prompt is now an agent's responsibility: switch from the queue wait to
    // the idle timer and arm the hard backstop. The claim itself counts as
    // liveness, so the idle window starts fresh here.
    entry.claimed = true;
    entry.hardDeadline = Date.now() + HARD_WAIT_MS;
    this.scheduleIdleTimeout(userId, entry);
    return {
      promptId: entry.id,
      prompt: entry.prompt,
      history: entry.history,
      ...(entry.attachments.length > 0
        ? { attachments: entry.attachments }
        : {}),
    };
  }

  /**
   * (Re)arm the in-flight idle timer for a claimed prompt. Clears any prior
   * timer and schedules a fresh IDLE_TIMEOUT_MS, clamped so it never fires past
   * the hard deadline. Called on claim and on every subsequent liveness signal.
   */
  private scheduleIdleTimeout(userId: string, entry: PendingPrompt): void {
    if (entry.settled) {
      return;
    }
    clearTimeout(entry.timer);
    const remaining = entry.hardDeadline - Date.now();
    const delay = Math.max(0, Math.min(IDLE_TIMEOUT_MS, remaining));
    entry.timer = setTimeout(() => {
      this.settleTimeout(userId, entry);
    }, delay);
  }

  /**
   * Reset the idle timer for whichever in-flight prompt this user's agent owns.
   * Called from every liveness signal (poll, progress, tool activity) so a slow
   * but alive agent is not timed out mid-task.
   */
  private bumpInFlight(userId: string): void {
    for (const record of this.inFlight.values()) {
      if (record.userId === userId && !record.prompt.settled) {
        this.scheduleIdleTimeout(userId, record.prompt);
      }
    }
  }

  private handOff(userId: string, entry: PendingPrompt, waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.resolve(this.claim(userId, entry));
  }

  private takeWaiter(userId: string): Waiter | undefined {
    const list = this.waiters.get(userId) ?? [];
    const [first, ...rest] = list;
    if (!first) {
      return undefined;
    }
    this.waiters.set(userId, rest);
    return first;
  }

  private removeWaiter(userId: string, waiter: Waiter): void {
    const list = this.waiters.get(userId) ?? [];
    this.waiters.set(
      userId,
      list.filter((w) => w !== waiter),
    );
  }

  private settleTimeout(userId: string, entry: PendingPrompt): void {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    // Drop it from whichever structure still holds it.
    this.inFlight.delete(entry.id);
    const queue = this.pending.get(userId) ?? [];
    if (queue.includes(entry)) {
      this.pending.set(
        userId,
        queue.filter((p) => p !== entry),
      );
    }
    // Distinguish "an agent took it then went quiet/disconnected" from "no agent
    // ever picked it up": the controller maps the two to different user-facing
    // copy, and a claimed prompt's answer is still recoverable via the buffer if
    // the agent comes back and posts.
    if (entry.claimed) {
      // Remember this prompt so a late post_response is still recognised and
      // buffered for pickup. Prune stale markers while we are here. Keep the
      // attachments around (TTL bounds them) in case the recovered agent
      // re-reads them before posting its late answer.
      this.pruneAwaitingLate();
      this.awaitingLate.set(entry.id, { userId, at: Date.now() });
      this.logger.warn(
        `Relay prompt ${entry.id} for user ${userId} went quiet after claim; ` +
          `browser gave up (late answer can still be buffered)`,
      );
      entry.reject(new RelayTimeoutError("disconnected", entry.id));
    } else {
      // Never claimed: no agent will ever read these attachments, so release
      // them now instead of waiting for the TTL.
      this.releaseAttachments(userId, entry);
      this.logger.warn(
        `Relay prompt ${entry.id} for user ${userId} timed out with no agent response`,
      );
      entry.reject(new RelayTimeoutError("no_agent", entry.id));
    }
  }

  /** Eagerly drop a settled prompt's attachments from the store (TTL backstop). */
  private releaseAttachments(userId: string, prompt: PendingPrompt): void {
    if (prompt.attachments.length === 0) {
      return;
    }
    this.attachmentStore.releaseForPrompt(
      userId,
      prompt.attachments.map((a) => a.id),
    );
  }
}

/**
 * Thrown when the browser gives up on a relay prompt. `reason` tells the
 * controller which copy to show: `no_agent` (never claimed) vs `disconnected`
 * (an agent claimed it then fell silent). `promptId` lets the browser try the
 * pickup endpoint for a late answer.
 */
export class RelayTimeoutError extends Error {
  constructor(
    readonly reason: "no_agent" | "disconnected",
    readonly promptId: string,
  ) {
    super(
      reason === "disconnected"
        ? "AI relay: your assistant went quiet before answering"
        : "AI relay timed out: no response from your assistant",
    );
    this.name = "RelayTimeoutError";
  }
}
