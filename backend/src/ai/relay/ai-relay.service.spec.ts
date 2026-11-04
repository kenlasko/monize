import { DataSource } from "typeorm";

import {
  AiRelayService,
  INACTIVITY_TIMEOUT_MS,
  RelayStreamClosedError,
  RelayTimeoutError,
  relayChannel,
  trimRelayHistory,
} from "./ai-relay.service";
import { RelayAttachmentStore } from "./relay-attachment.store";
import { RelayStreamRegistry } from "./relay-stream.registry";
import { createRelayRowsHarness, RelayRowsHarness } from "./relay-rows.harness";
import { MemoryEventBus } from "../../common/events/memory-event-bus";
import { RelayServerEvent } from "./ai-relay.types";
import { PendingAiAction } from "../actions/ai-action.types";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const OTHER = "user-2";

const QUEUE_WAIT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 180 * 1000;
const BUFFER_TTL_MS = 10 * 60 * 1000;
const POLL_PARK_MS = 25 * 1000;
const WAKE_POLL_INTERVAL_MS = 5 * 1000;

// A valid 1x1 PNG (header + minimal body) so attachment validation passes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function card(actionId: string): PendingAiAction {
  return {
    actionId,
    descriptor: { kind: "create_transaction" },
  } as unknown as PendingAiAction;
}

describe("AiRelayService", () => {
  let service: AiRelayService;
  let harness: RelayRowsHarness;
  let attachmentStore: RelayAttachmentStore;
  let streams: RelayStreamRegistry;
  let bus: MemoryEventBus;

  /**
   * Let every already-resolvable await run: the row statements are immediate
   * promises and the memory bus delivers on the next microtask, so this is what
   * "the relay has finished reacting" looks like under fake timers.
   */
  const settle = () => jest.advanceTimersByTimeAsync(0);

  /**
   * Start a turn. Many tests deliberately leave one unanswered, and a rejection
   * nobody is awaiting yet reads as an unhandled rejection rather than as the
   * timeout the test is about -- so the promise is marked handled here and
   * still returned for the assertions.
   */
  const start = (
    user: string,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }> = [],
    options?: Parameters<AiRelayService["enqueuePrompt"]>[3],
  ) => {
    const pending = service.enqueuePrompt(user, prompt, history, options);
    pending.catch(() => undefined);
    return pending;
  };

  beforeEach(() => {
    // Fake timers so the parked waiters never leak onto the real clock in tests
    // that intentionally leave a prompt unanswered.
    jest.useFakeTimers();
    harness = createRelayRowsHarness();
    attachmentStore = harness.attachmentStore;
    streams = new RelayStreamRegistry();
    bus = new MemoryEventBus();
    service = new AiRelayService(
      harness.dataSource as unknown as DataSource,
      attachmentStore,
      streams,
      bus,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("the round trip", () => {
    it("delivers an answer when an agent claims a queued prompt and responds", async () => {
      const pending = start(USER, "hello", []);
      await settle();

      const claimed = await service.waitForPrompt(USER);
      expect(claimed).not.toBeNull();
      expect(claimed?.prompt).toBe("hello");

      expect(
        await service.postResponse(USER, claimed!.promptId, "hi there"),
      ).toBe(true);
      await settle();

      await expect(pending).resolves.toEqual({ text: "hi there" });
    });

    it("hands a prompt to an already-parked agent", async () => {
      const parked = service.waitForPrompt(USER);
      await settle();
      // The agent is parked with nothing queued yet.
      expect((await service.getStatus(USER)).state).toBe("listening");

      const pending = start(USER, "q", []);
      await settle();

      const claimed = await parked;
      expect(claimed?.prompt).toBe("q");

      await service.postResponse(USER, claimed!.promptId, "a");
      await settle();
      await expect(pending).resolves.toEqual({ text: "a" });
    });

    it("claims prompts in FIFO order", async () => {
      const first = start(USER, "first");
      await settle();
      const second = start(USER, "second");
      await settle();

      const a = await service.waitForPrompt(USER);
      const b = await service.waitForPrompt(USER);
      expect(a?.prompt).toBe("first");
      expect(b?.prompt).toBe("second");

      await service.postResponse(USER, a!.promptId, "1");
      await service.postResponse(USER, b!.promptId, "2");
      await settle();
      await expect(first).resolves.toEqual({ text: "1" });
      await expect(second).resolves.toEqual({ text: "2" });
    });

    it("hands one queued prompt to exactly one of two polling agents", async () => {
      const pending = start(USER, "only one");
      await settle();

      const pollA = service.waitForPrompt(USER, "session-a");
      const pollB = service.waitForPrompt(USER, "session-b");
      // The loser parks out its whole window rather than getting a second copy.
      await jest.advanceTimersByTimeAsync(POLL_PARK_MS + 1000);
      const [a, b] = await Promise.all([pollA, pollB]);

      expect([a, b].filter(Boolean)).toHaveLength(1);

      const winner = (a ?? b)!;
      await service.postResponse(USER, winner.promptId, "done");
      await settle();
      await expect(pending).resolves.toEqual({ text: "done" });
    });

    it("passes history through to the claimed prompt", async () => {
      const history = [
        { role: "user" as const, content: "earlier" },
        { role: "assistant" as const, content: "reply" },
      ];
      void start(USER, "now", history);
      await settle();

      const claimed = await service.waitForPrompt(USER);
      expect(claimed?.history).toEqual(history);
    });

    it("trims a long history before handing it to the agent", async () => {
      const history = Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `turn ${i}`,
      }));
      void start(USER, "now", history);
      await settle();

      const claimed = await service.waitForPrompt(USER);
      expect(claimed!.history).toHaveLength(10);
      expect(claimed!.history[9].content).toBe("turn 29");
    });

    it("publishes a wake-up carrying ids only, never the prompt or the answer", async () => {
      const seen: Array<Record<string, unknown>> = [];
      bus.subscribe(relayChannel(USER), (payload) => seen.push(payload));

      const pending = start(USER, "secret question", []);
      await settle();
      const claimed = await service.waitForPrompt(USER);
      await service.postResponse(USER, claimed!.promptId, "secret answer");
      await settle();
      await pending;

      expect(seen).toHaveLength(2);
      for (const payload of seen) {
        expect(Object.keys(payload).sort()).toEqual(["promptId", "userId"]);
      }
    });
  });

  describe("post_response", () => {
    it("refuses an unknown or foreign promptId", async () => {
      const pending = start(USER, "q", []);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      expect(await service.postResponse(USER, "prompt-999", "x")).toBe(false);
      expect(await service.postResponse(OTHER, claimed!.promptId, "x")).toBe(
        false,
      );

      await service.postResponse(USER, claimed!.promptId, "ok");
      await settle();
      await expect(pending).resolves.toEqual({ text: "ok" });
    });

    it("refuses a turn nobody has claimed", async () => {
      void start(USER, "q", []);
      await settle();

      // The id is guessable only to a caller that already had it; what refuses
      // here is the status, which is still `pending`.
      expect(await service.postResponse(USER, harness.rows[0].id, "x")).toBe(
        false,
      );
    });

    it("refuses a second answer for the same turn", async () => {
      const pending = start(USER, "q", []);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      expect(await service.postResponse(USER, claimed!.promptId, "first")).toBe(
        true,
      );
      // The loser of a double post learns it lost from the database, not from a
      // read it had already passed.
      expect(
        await service.postResponse(USER, claimed!.promptId, "second"),
      ).toBe(false);

      await settle();
      await expect(pending).resolves.toEqual({ text: "first" });
    });
  });

  describe("timeouts", () => {
    it("returns null from a parked poll after the poll window", async () => {
      const parked = service.waitForPrompt(USER);
      await jest.advanceTimersByTimeAsync(POLL_PARK_MS);
      await expect(parked).resolves.toBeNull();
    });

    it("gives up on a never-claimed prompt after the queue wait", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1000);

      const error = await settled;
      expect(error).toBeInstanceOf(RelayTimeoutError);
      expect((error as RelayTimeoutError).reason).toBe("no_agent");
    });

    it("gives up on a claimed prompt that goes silent, and says so", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await settle();
      await service.waitForPrompt(USER);

      await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);

      const error = await settled;
      expect(error).toBeInstanceOf(RelayTimeoutError);
      // Different copy from `no_agent`: an agent took this one and went quiet,
      // and its late answer is still accepted.
      expect((error as RelayTimeoutError).reason).toBe("disconnected");
    });

    it("keeps a slow-but-alive agent's turn across the idle window", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      // Three quarters of the way to the deadline, twice: without the liveness
      // push-out the second one would land past it.
      for (let i = 0; i < 4; i++) {
        await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 0.75);
        await service.reportProgress(USER, claimed!.promptId, "still working");
      }

      await service.postResponse(USER, claimed!.promptId, "finally");
      await settle();
      await expect(settled).resolves.toEqual({ text: "finally" });
    });

    it("enforces the hard upper bound even for a chatty agent", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      for (let i = 0; i < 30; i++) {
        await jest.advanceTimersByTimeAsync(60_000);
        await service.reportProgress(USER, claimed!.promptId, "still here");
      }

      const error = await settled;
      expect(error).toBeInstanceOf(RelayTimeoutError);
      expect((error as RelayTimeoutError).reason).toBe("disconnected");
    });

    it("stops waiting as soon as the browser's socket closes", async () => {
      const closed = new AbortController();
      const pending = start(USER, "q", [], {
        signal: closed.signal,
      });
      const settled = pending.catch((e: unknown) => e);
      await settle();

      closed.abort();
      await settle();

      // Not a failure of the turn: the row is untouched, so an agent may still
      // claim and answer it and the pickup endpoint serves that answer.
      await expect(settled).resolves.toBeInstanceOf(RelayStreamClosedError);
      expect(harness.rows[0].status).toBe("pending");
    });
  });

  describe("late answers", () => {
    it("keeps an answer posted after the browser gave up, and serves it on pickup", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
      await expect(settled).resolves.toBeInstanceOf(RelayTimeoutError);

      // The agent recovered and posted after the stream was gone.
      expect(await service.postResponse(USER, claimed!.promptId, "late")).toBe(
        true,
      );

      await expect(
        service.takeBufferedResponse(USER, claimed!.promptId),
      ).resolves.toEqual({ text: "late" });
    });

    it("hands a late answer over exactly once", async () => {
      const promptId = await answeredLateTurn();

      await expect(
        service.takeBufferedResponse(USER, promptId),
      ).resolves.toEqual({ text: "late" });
      await expect(
        service.takeBufferedResponse(USER, promptId),
      ).resolves.toBeNull();
    });

    it("does not serve another user's late answer", async () => {
      const promptId = await answeredLateTurn();
      await expect(
        service.takeBufferedResponse(OTHER, promptId),
      ).resolves.toBeNull();
    });

    it("stops accepting an answer once the grace after the deadline has run out", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch(() => undefined);
      await settle();
      const claimed = await service.waitForPrompt(USER);

      await jest.advanceTimersByTimeAsync(
        IDLE_TIMEOUT_MS + BUFFER_TTL_MS + 1000,
      );
      await settled;

      expect(
        await service.postResponse(USER, claimed!.promptId, "far too late"),
      ).toBe(false);
    });

    it("returns null when picking up an unknown prompt", async () => {
      await expect(
        service.takeBufferedResponse(USER, "prompt-999"),
      ).resolves.toBeNull();
    });

    /** Drive a turn to "claimed, browser gone, agent answered late". */
    async function answeredLateTurn(): Promise<string> {
      const pending = start(USER, "q", []);
      const settled = pending.catch(() => undefined);
      await settle();
      const claimed = await service.waitForPrompt(USER);
      await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
      await settled;
      await service.postResponse(USER, claimed!.promptId, "late");
      return claimed!.promptId;
    }
  });

  describe("emitPendingAction", () => {
    it("returns false when the user has no relay turn at all", async () => {
      expect(await service.emitPendingAction(USER, card("a1"))).toBe(false);
    });

    it("emits the card on the turn's own live stream", async () => {
      const emit = jest.fn();
      void start(USER, "q", [], { emit });
      await settle();
      await service.waitForPrompt(USER, "session-a");

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(true);
      expect(emit).toHaveBeenCalledWith({
        type: "pending_action",
        action: card("a1"),
      });
    });

    it("does not target another user's turn", async () => {
      const emit = jest.fn();
      void start(OTHER, "q", [], { emit });
      await settle();
      await service.waitForPrompt(OTHER, "session-a");

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });

    it("buffers the card when the turn has no live stream here", async () => {
      void start(USER, "q", []);
      await settle();
      await service.waitForPrompt(USER, "session-a");

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(true);
      await expect(service.takeBufferedActions(USER)).resolves.toEqual([
        card("a1"),
      ]);
    });

    it("buffers a card emitted after the browser gave up, for pickup", async () => {
      const emit = jest.fn();
      const pending = start(USER, "q", [], { emit });
      const settled = pending.catch(() => undefined);
      await settle();
      await service.waitForPrompt(USER, "session-a");

      await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
      await settled;

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(true);
      await expect(service.takeBufferedActions(USER)).resolves.toEqual([
        card("a1"),
      ]);
    });

    it("does not let a stale turn capture a later write forever", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch(() => undefined);
      await settle();
      await service.waitForPrompt(USER, "session-a");
      await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
      await settled;

      await jest.advanceTimersByTimeAsync(BUFFER_TTL_MS + 1000);

      // Past the grace the turn is over: this is a direct client's write and
      // must confirm in the client, not in a web chat nobody is watching.
      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(false);
    });

    it("does not hand one session's relay turn to another session's write", async () => {
      const emit = jest.fn();
      void start(USER, "q", [], { emit });
      await settle();
      await service.waitForPrompt(USER, "session-a");

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-b"),
      ).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });

    it("keeps the turn when the claiming agent reconnects with a new session id", async () => {
      const emit = jest.fn();
      void start(USER, "q", [], { emit });
      await settle();
      const claimed = await service.waitForPrompt(USER, "session-a");

      // The agent reconnected: a fresh MCP session, proving ownership by
      // knowing the (unguessable) promptId.
      await service.reportProgress(
        USER,
        claimed!.promptId,
        "back",
        "session-b",
      );

      expect(
        await service.emitPendingAction(USER, card("a1"), "session-b"),
      ).toBe(true);
      expect(emit).toHaveBeenCalledWith({
        type: "pending_action",
        action: card("a1"),
      });
    });

    it("does not route a card to the web chat while an agent is merely parked", async () => {
      void service.waitForPrompt(USER, "session-a");
      await settle();

      // Parked is not claimed: there is no turn for this write to belong to.
      expect(
        await service.emitPendingAction(USER, card("a1"), "session-a"),
      ).toBe(false);
    });

    it("drains buffered cards oldest first and only once", async () => {
      void start(USER, "q", []);
      await settle();
      await service.waitForPrompt(USER, "session-a");

      await service.emitPendingAction(USER, card("a1"), "session-a");
      await jest.advanceTimersByTimeAsync(10);
      await service.emitPendingAction(USER, card("a2"), "session-a");

      await expect(service.takeBufferedActions(USER)).resolves.toEqual([
        card("a1"),
        card("a2"),
      ]);
      await expect(service.takeBufferedActions(USER)).resolves.toEqual([]);
    });

    it("drops a buffered card past its TTL", async () => {
      void start(USER, "q", []);
      await settle();
      await service.waitForPrompt(USER, "session-a");
      await service.emitPendingAction(USER, card("a1"), "session-a");

      await jest.advanceTimersByTimeAsync(BUFFER_TTL_MS + 1000);

      await expect(service.takeBufferedActions(USER)).resolves.toEqual([]);
    });
  });

  describe("reportProgress", () => {
    it("returns false when the prompt is not this caller's turn", async () => {
      expect(await service.reportProgress(USER, "prompt-999", "x")).toBe(false);
    });

    it("streams an assistant_text event, newline-terminated", async () => {
      const emit = jest.fn();
      void start(USER, "q", [], { emit });
      await settle();
      const claimed = await service.waitForPrompt(USER);

      expect(
        await service.reportProgress(USER, claimed!.promptId, "looking"),
      ).toBe(true);
      expect(emit).toHaveBeenCalledWith({
        type: "assistant_text",
        text: "looking\n",
      });
    });

    it("does not target another user's prompt", async () => {
      const emit = jest.fn();
      void start(OTHER, "q", [], { emit });
      await settle();
      const claimed = await service.waitForPrompt(OTHER);

      expect(await service.reportProgress(USER, claimed!.promptId, "x")).toBe(
        false,
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it("returns false once the prompt has been answered", async () => {
      const emit = jest.fn();
      const pending = start(USER, "q", [], { emit });
      await settle();
      const claimed = await service.waitForPrompt(USER);
      await service.postResponse(USER, claimed!.promptId, "done");
      await settle();
      await pending;

      expect(
        await service.reportProgress(USER, claimed!.promptId, "late"),
      ).toBe(false);
    });
  });

  describe("reportToolActivity", () => {
    it("streams tool_start and tool_result on the in-flight turn", async () => {
      const events: RelayServerEvent[] = [];
      void start(USER, "q", [], {
        emit: (e) => events.push(e),
      });
      await settle();
      await service.waitForPrompt(USER, "session-a");

      await service.reportToolActivity(
        USER,
        "list_transactions",
        "start",
        false,
        "session-a",
      );
      await service.reportToolActivity(
        USER,
        "list_transactions",
        "result",
        false,
        "session-a",
      );

      expect(events).toEqual([
        { type: "tool_start", name: "list_transactions" },
        { type: "tool_result", name: "list_transactions", isError: false },
      ]);
    });

    it("is a no-op when the caller has no relay turn", async () => {
      await expect(
        service.reportToolActivity(USER, "list_accounts", "start"),
      ).resolves.toBeUndefined();
    });

    it("does not mirror another session's tool calls into the web chat", async () => {
      const emit = jest.fn();
      void start(USER, "q", [], { emit });
      await settle();
      await service.waitForPrompt(USER, "session-a");

      await service.reportToolActivity(
        USER,
        "list_accounts",
        "start",
        false,
        "session-b",
      );

      expect(emit).not.toHaveBeenCalled();
    });

    it("does not let another session's tool calls keep an abandoned turn alive", async () => {
      const pending = start(USER, "q", []);
      const settled = pending.catch((e: unknown) => e);
      await settle();
      await service.waitForPrompt(USER, "session-a");

      // A direct MCP client of the same user keeps working throughout.
      for (let i = 0; i < 4; i++) {
        await jest.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 0.75);
        await service.reportToolActivity(
          USER,
          "list_accounts",
          "start",
          false,
          "session-b",
        );
      }

      await expect(settled).resolves.toBeInstanceOf(RelayTimeoutError);
    });
  });

  describe("status", () => {
    it("is offline before any agent polls", async () => {
      expect(await service.getStatus(USER)).toEqual({
        state: "offline",
        queued: 0,
      });
    });

    it("stays offline on tool activity alone (a direct MCP client is not a relay agent)", async () => {
      await service.reportToolActivity(USER, "list_accounts", "start");
      expect((await service.getStatus(USER)).state).toBe("offline");
    });

    it("is busy while a claimed prompt is in flight", async () => {
      void start(USER, "q", []);
      await settle();
      await service.waitForPrompt(USER);

      expect((await service.getStatus(USER)).state).toBe("busy");
    });

    it("reports the queued count, and only live rows", async () => {
      void start(USER, "one", []);
      await settle();
      void start(USER, "two", []);
      await settle();

      expect((await service.getStatus(USER)).queued).toBe(2);

      await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1000);
      expect((await service.getStatus(USER)).queued).toBe(0);
    });
  });

  describe("attachments", () => {
    const upload = () => [
      {
        kind: "image" as const,
        mediaType: "image/png",
        filename: "shot.png",
        data: PNG_BASE64,
      },
    ];

    it("stores attachments and surfaces refs on the claimed prompt", async () => {
      void start(USER, "what is this", [], {
        attachments: upload(),
      });
      await settle();

      const claimed = await service.waitForPrompt(USER);
      expect(claimed!.attachments).toHaveLength(1);
      expect(claimed!.attachments![0].filename).toBe("shot.png");
      await expect(
        attachmentStore.get(USER, claimed!.attachments![0].id),
      ).resolves.toBeDefined();
    });

    it("omits attachments from the claimed prompt when none were uploaded", async () => {
      void start(USER, "q", []);
      await settle();

      const claimed = await service.waitForPrompt(USER);
      expect(claimed!.attachments).toBeUndefined();
    });

    it("releases stored attachments once the prompt is answered", async () => {
      const pending = start(USER, "q", [], {
        attachments: upload(),
      });
      await settle();
      const claimed = await service.waitForPrompt(USER);
      const id = claimed!.attachments![0].id;

      await service.postResponse(USER, claimed!.promptId, "a picture");
      await settle();
      await pending;

      await expect(attachmentStore.get(USER, id)).resolves.toBeUndefined();
    });

    it("releases stored attachments when no agent ever claims the prompt", async () => {
      const pending = start(USER, "q", [], {
        attachments: upload(),
      });
      const settled = pending.catch(() => undefined);
      await settle();
      const id = harness.rows[0].prompt.attachments![0].id;

      await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1000);
      await settled;

      await expect(attachmentStore.get(USER, id)).resolves.toBeUndefined();
    });

    it("rejects before the prompt is ever queued when an attachment fails validation", async () => {
      await expect(
        service.enqueuePrompt(USER, "q", [], {
          attachments: [
            {
              kind: "image" as const,
              mediaType: "image/png",
              filename: "fake.png",
              data: Buffer.from("not a png").toString("base64"),
            },
          ],
        }),
      ).rejects.toThrow();
      expect(harness.rows).toHaveLength(0);
    });
  });

  describe("inactivity disconnect", () => {
    it("signals stop after the inactivity timeout of empty polls", async () => {
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS + 1000);
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(true);
      expect((await service.getStatus(USER)).idleDisconnected).toBe(true);
    });

    it("resets the idle clock when a new prompt arrives", async () => {
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1000);

      void start(USER, "still here", []);
      await settle();

      await jest.advanceTimersByTimeAsync(2000);
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(false);
    });

    it("clears the idle-disconnect notice once the agent polls again", async () => {
      await service.shouldStopForIdle(USER);
      await jest.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS + 1000);
      await service.shouldStopForIdle(USER);

      void service.waitForPrompt(USER);
      await settle();

      expect((await service.getStatus(USER)).idleDisconnected).toBeUndefined();
    });

    it("does not trip while a conversation is active (a claim resets the clock)", async () => {
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1000);

      void start(USER, "q", []);
      await settle();
      await service.waitForPrompt(USER);

      await jest.advanceTimersByTimeAsync(2000);
      await expect(service.shouldStopForIdle(USER)).resolves.toBe(false);
    });
  });

  describe("streams", () => {
    it("holds no stream once the turn is over", async () => {
      const pending = start(USER, "q", [], {
        emit: jest.fn(),
      });
      await settle();
      const claimed = await service.waitForPrompt(USER);
      await service.postResponse(USER, claimed!.promptId, "done");
      await settle();
      await pending;

      // A stream left registered outlives the socket it was serving.
      expect(streams.activeCount()).toBe(0);
    });

    it("holds no stream after the browser gives up", async () => {
      const pending = start(USER, "q", [], {
        emit: jest.fn(),
      });
      const settled = pending.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS + 1000);
      await settled;

      expect(streams.activeCount()).toBe(0);
    });
  });

  describe("across replicas", () => {
    /** A second backend over the same rows and the same bus. */
    const secondReplica = () =>
      new AiRelayService(
        harness.dataSource as unknown as DataSource,
        harness.attachmentStore,
        new RelayStreamRegistry(),
        bus,
      );

    it("lets an agent polling one replica claim a prompt queued on another", async () => {
      const other = secondReplica();
      const pending = start(USER, "queued over there");
      await settle();

      const claimed = await other.waitForPrompt(USER, "session-a");
      expect(claimed?.prompt).toBe("queued over there");

      await other.postResponse(USER, claimed!.promptId, "answered over here");
      await settle();
      await expect(pending).resolves.toEqual({ text: "answered over here" });
    });

    it("keeps the agent's liveness and the queue on rows, not in a process", async () => {
      const poll = service.waitForPrompt(USER, "session-a");
      await jest.advanceTimersByTimeAsync(POLL_PARK_MS + 1000);
      await poll;
      start(USER, "q");
      await settle();

      // Nothing about this user's tunnel lives in the process that served the
      // poll, which is the whole point of the move.
      const other = secondReplica();
      expect(await other.getStatus(USER)).toEqual({
        state: "listening",
        queued: 1,
      });
    });

    it("hands a card buffered on one replica to a pickup served by another", async () => {
      start(USER, "q");
      await settle();
      await service.waitForPrompt(USER, "session-a");
      await service.emitPendingAction(USER, card("a1"), "session-a");

      await expect(secondReplica().takeBufferedActions(USER)).resolves.toEqual([
        card("a1"),
      ]);
    });
  });

  describe("the park length", () => {
    it("parks for the injected length instead of POLL_PARK_MS when one is given", async () => {
      const short = new AiRelayService(
        harness.dataSource as unknown as DataSource,
        attachmentStore,
        streams,
        bus,
        1000,
      );
      let result: unknown = "still parked";
      const poll = short.waitForPrompt(USER, "session-a").then((r) => {
        result = r;
      });

      await jest.advanceTimersByTimeAsync(500);
      expect(result).toBe("still parked");
      await jest.advanceTimersByTimeAsync(600);
      await poll;
      expect(result).toBeNull();
    });

    it("parks for POLL_PARK_MS when nothing is injected", async () => {
      let result: unknown = "still parked";
      const poll = service.waitForPrompt(USER, "session-a").then((r) => {
        result = r;
      });

      await jest.advanceTimersByTimeAsync(POLL_PARK_MS - 1000);
      expect(result).toBe("still parked");
      await jest.advanceTimersByTimeAsync(2000);
      await poll;
      expect(result).toBeNull();
    });
  });

  describe("the agent row", () => {
    it("keeps one liveness row per user however often the agent polls", async () => {
      const first = service.waitForPrompt(USER, "session-a");
      await jest.advanceTimersByTimeAsync(POLL_PARK_MS + 1000);
      await first;
      const second = service.waitForPrompt(USER, "session-a");
      await jest.advanceTimersByTimeAsync(POLL_PARK_MS + 1000);
      await second;

      expect(harness.agents.filter((a) => a.userId === USER)).toHaveLength(1);
      expect(harness.agents[0].lastPollAt).not.toBeNull();
    });

    it("treats a repeat of one card id as the same card", async () => {
      start(USER, "q");
      await settle();
      await service.waitForPrompt(USER, "session-a");

      await service.emitPendingAction(USER, card("a1"), "session-a");
      await service.emitPendingAction(USER, card("a1"), "session-a");

      // The descriptor's id is the card's identity: the browser must be offered
      // one card to approve, not two of the same write.
      await expect(service.takeBufferedActions(USER)).resolves.toEqual([
        card("a1"),
      ]);
    });
  });

  describe("failures that must not lose committed work", () => {
    /** Make one statement reject, leaving the harness to answer the rest. */
    function breakStatement(fragment: string): void {
      const query = harness.dataSource.manager.query as jest.Mock;
      const rows = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (String(sql).includes(fragment)) {
          throw new Error(`statement failed: ${fragment}`);
        }
        return rows(sql, params);
      });
    }

    it("still reports an answer as delivered when the wake-up cannot be published", async () => {
      start(USER, "q");
      await settle();
      const claimed = await service.waitForPrompt(USER, "session-a");
      jest
        .spyOn(bus, "publish")
        .mockRejectedValue(new Error("notification connection is down"));

      // The row is already committed. Reporting failure would have the agent
      // retry a turn it has finished -- and the retry would be refused, so its
      // work would look lost twice over.
      await expect(
        service.postResponse(USER, claimed!.promptId, "done"),
      ).resolves.toBe(true);
      expect(harness.rows[0].status).toBe("answered");
    });

    it("still queues a prompt when the wake-up cannot be published", async () => {
      jest
        .spyOn(bus, "publish")
        .mockRejectedValue(new Error("notification connection is down"));

      const pending = start(USER, "q");
      await settle();

      // A waiter re-reads on its own timer, so a lost wake-up costs latency.
      // Failing here would show a timeout for a prompt live in the queue.
      expect(harness.rows).toHaveLength(1);
      const claimed = await service.waitForPrompt(USER, "session-a");
      expect(claimed?.prompt).toBe("q");
      await service.postResponse(USER, claimed!.promptId, "a");
      await jest.advanceTimersByTimeAsync(WAKE_POLL_INTERVAL_MS);
      await expect(pending).resolves.toEqual({ text: "a" });
    });

    it("claims and resets the inactivity clock in one transaction", async () => {
      start(USER, "q");
      await settle();
      await service.waitForPrompt(USER, "session-a");

      // A second transaction for the clock could fail after the claim was
      // durable, leaving a turn marked `claimed` by an agent that never learned
      // its id. That the rollback really happens is a PostgreSQL property and
      // is asserted in ai-relay-claim.integration.spec.ts; what this proves is
      // that the two statements were handed to one transaction to begin with.
      const grouped = harness.transactions.find((tx) =>
        tx.some((sql) => sql.includes("WITH next AS")),
      );
      expect(grouped).toBeDefined();
      expect(
        grouped!.some((sql) => sql.includes("INSERT INTO ai_relay_agents")),
      ).toBe(true);
    });

    it("still hands over the answer when the attachment release fails", async () => {
      const pending = start(USER, "q", [], {
        attachments: [
          {
            kind: "image" as const,
            mediaType: "image/png",
            filename: "shot.png",
            data: PNG_BASE64,
          },
        ],
      });
      await settle();
      const claimed = await service.waitForPrompt(USER, "session-a");
      jest
        .spyOn(attachmentStore, "releaseForPrompt")
        .mockRejectedValue(new Error("delete failed"));

      await service.postResponse(USER, claimed!.promptId, "a picture");
      await settle();

      // The answer is already consumed, so throwing here would destroy it. The
      // TTL and the sweep are the backstop, which is why the release is eager
      // rather than required.
      await expect(pending).resolves.toEqual({ text: "a picture" });
    });

    it("never throws out of reportToolActivity", async () => {
      start(USER, "q");
      await settle();
      await service.waitForPrompt(USER, "session-a");
      breakStatement("SET expires_at = LEAST");

      // The MCP wrapper reports the result phase in a `finally`, where a throw
      // replaces the tool's own outcome -- so a committed write would surface
      // as an error the agent then retries.
      await expect(
        service.reportToolActivity(
          USER,
          "manage_transactions",
          "result",
          false,
          "session-a",
        ),
      ).resolves.toBeUndefined();
    });

    it("keeps one session's tool chip on the turn it is working", async () => {
      // An agent that polls again mid-turn holds two claimed prompts. An
      // UPDATE's RETURNING has no order, so the newest claim decides -- the
      // same choice the card lookup makes.
      const events: RelayServerEvent[] = [];
      start(USER, "first");
      await settle();
      const first = await service.waitForPrompt(USER, "session-a");
      start(USER, "second", [], { emit: (e) => events.push(e) });
      await settle();
      await jest.advanceTimersByTimeAsync(1000);
      const second = await service.waitForPrompt(USER, "session-a");
      expect(second?.promptId).not.toBe(first?.promptId);

      await service.reportToolActivity(
        USER,
        "list_accounts",
        "start",
        false,
        "session-a",
      );

      expect(events).toContainEqual({
        type: "tool_start",
        name: "list_accounts",
      });
    });
  });

  describe("trimRelayHistory", () => {
    it("returns a short history unchanged", () => {
      const history = [{ role: "user" as const, content: "hello" }];
      expect(trimRelayHistory(history)).toEqual(history);
    });

    it("keeps only the most recent turns, oldest first", () => {
      const history = Array.from({ length: 25 }, (_, i) => ({
        role: "user" as const,
        content: `turn ${i}`,
      }));
      const kept = trimRelayHistory(history);
      expect(kept).toHaveLength(10);
      expect(kept[0].content).toBe("turn 15");
      expect(kept[9].content).toBe("turn 24");
    });

    it("drops older turns once the char budget is exhausted", () => {
      const history = [
        { role: "user" as const, content: "x".repeat(11000) },
        { role: "assistant" as const, content: "y".repeat(2000) },
      ];
      const kept = trimRelayHistory(history);
      expect(kept).toHaveLength(1);
      expect(kept[0].content.startsWith("y")).toBe(true);
    });

    it("keeps but truncates a single newest turn that exceeds the budget", () => {
      const kept = trimRelayHistory([
        { role: "user", content: "z".repeat(20000) },
      ]);
      expect(kept).toHaveLength(1);
      expect(kept[0].content.length).toBeLessThan(20000);
      expect(kept[0].content.endsWith("[truncated]")).toBe(true);
    });

    it("returns an empty array for an empty history", () => {
      expect(trimRelayHistory([])).toEqual([]);
    });
  });
});
