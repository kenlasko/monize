import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  RelayClaimedPrompt,
  RelayResponse,
  RelayServerEvent,
  RelayTunnelState,
  RelayTunnelStatus,
} from "./ai-relay.types";
import { PendingAiAction } from "../actions/ai-action.types";

/**
 * How long the browser waits for the agent to answer before giving up. The
 * agent may read files, call several tools, and think, so this is generous.
 */
const BROWSER_WAIT_MS = 5 * 60 * 1000; // 5 minutes

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

interface PendingPrompt {
  id: string;
  prompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  resolve: (response: RelayResponse) => void;
  reject: (err: Error) => void;
  /** Browser-side timeout handle; cleared once the prompt settles. */
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
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
   * Enqueue a prompt from the browser and resolve when the agent answers.
   * If an agent is already parked, the prompt is handed off immediately;
   * otherwise it waits in the queue until claimed (or the browser times out).
   */
  enqueuePrompt(
    userId: string,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    emit?: (event: RelayServerEvent) => void,
  ): Promise<RelayResponse> {
    return new Promise<RelayResponse>((resolve, reject) => {
      const entry: PendingPrompt = {
        id: randomUUID(),
        prompt,
        history,
        resolve,
        reject,
        settled: false,
        emit,
        timer: setTimeout(() => {
          this.settleTimeout(userId, entry);
        }, BROWSER_WAIT_MS),
      };

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

    const queue = this.pending.get(userId) ?? [];
    const [next, ...rest] = queue;
    if (next) {
      this.pending.set(userId, rest);
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
   * Called by the `post_response` MCP tool. Delivers the agent's answer to the
   * waiting browser request. Returns false if no matching in-flight prompt
   * exists for this user (wrong id, already answered, or timed out).
   */
  postResponse(userId: string, promptId: string, text: string): boolean {
    this.lastPollAt.set(userId, Date.now());
    const record = this.inFlight.get(promptId);
    if (!record || record.userId !== userId) {
      return false;
    }
    this.inFlight.delete(promptId);
    const { prompt } = record;
    if (prompt.settled) {
      return false;
    }
    prompt.settled = true;
    clearTimeout(prompt.timer);
    prompt.resolve({ text });
    return true;
  }

  /**
   * Push a write-confirmation card to the browser parked on this user's
   * in-flight relay prompt. Called by the MCP write tools when they detect they
   * are serving a relayed prompt: instead of an MCP-client elicitation (which
   * the user would have to accept in their CLI), the approve/reject card is
   * rendered in the web chat, exactly like the native AI Assistant.
   *
   * Returns true when a card was delivered (the caller is in relay context and
   * must NOT perform the write -- the browser commits it via /ai/actions/confirm
   * on approval). Returns false when the user has no in-flight relay prompt, so
   * the caller falls back to its normal (direct MCP-client) confirmation.
   */
  emitPendingAction(userId: string, action: PendingAiAction): boolean {
    for (const record of this.inFlight.values()) {
      if (record.userId !== userId) {
        continue;
      }
      const { prompt } = record;
      if (prompt.settled || !prompt.emit) {
        return false;
      }
      prompt.emit({ type: "pending_action", action });
      return true;
    }
    return false;
  }

  /** Tunnel status for the chat indicator. */
  getStatus(userId: string): RelayTunnelStatus {
    return {
      state: this.computeState(userId),
      queued: (this.pending.get(userId) ?? []).length,
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
    return {
      promptId: entry.id,
      prompt: entry.prompt,
      history: entry.history,
    };
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
    this.logger.warn(
      `Relay prompt ${entry.id} for user ${userId} timed out with no agent response`,
    );
    entry.reject(
      new Error("AI relay timed out: no response from your assistant"),
    );
  }
}
