import { AiRelayService } from "./ai-relay.service";

const USER = "user-1";
const OTHER = "user-2";

describe("AiRelayService", () => {
  let service: AiRelayService;

  beforeEach(() => {
    // Fake timers so the long browser-wait timer set by enqueuePrompt never
    // leaks onto the real clock in tests that intentionally leave a prompt
    // unanswered.
    jest.useFakeTimers();
    service = new AiRelayService();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("delivers an answer when an agent claims a queued prompt and responds", async () => {
    const pending = service.enqueuePrompt(USER, "hello", []);

    const claimed = await service.waitForPrompt(USER);
    expect(claimed).not.toBeNull();
    expect(claimed?.prompt).toBe("hello");

    const delivered = service.postResponse(USER, claimed!.promptId, "hi there");
    expect(delivered).toBe(true);

    await expect(pending).resolves.toEqual({ text: "hi there" });
  });

  it("hands a prompt to an already-parked agent", async () => {
    const waiterPromise = service.waitForPrompt(USER);
    // The agent is parked with nothing queued yet.
    expect(service.getStatus(USER).state).toBe("listening");

    const pending = service.enqueuePrompt(USER, "q", []);
    const claimed = await waiterPromise;
    expect(claimed?.prompt).toBe("q");

    service.postResponse(USER, claimed!.promptId, "a");
    await expect(pending).resolves.toEqual({ text: "a" });
  });

  it("claims prompts in FIFO order", async () => {
    const first = service.enqueuePrompt(USER, "first", []);
    const second = service.enqueuePrompt(USER, "second", []);

    const a = await service.waitForPrompt(USER);
    const b = await service.waitForPrompt(USER);
    expect(a?.prompt).toBe("first");
    expect(b?.prompt).toBe("second");

    service.postResponse(USER, a!.promptId, "1");
    service.postResponse(USER, b!.promptId, "2");
    await expect(first).resolves.toEqual({ text: "1" });
    await expect(second).resolves.toEqual({ text: "2" });
  });

  it("passes history through to the claimed prompt", async () => {
    const history = [{ role: "user" as const, content: "earlier" }];
    service.enqueuePrompt(USER, "q", history);
    const claimed = await service.waitForPrompt(USER);
    expect(claimed?.history).toEqual(history);
  });

  it("rejects post_response for an unknown or foreign prompt", async () => {
    service.enqueuePrompt(USER, "q", []);
    const claimed = await service.waitForPrompt(USER);

    expect(
      service.postResponse(USER, "00000000-0000-0000-0000-000000000000", "x"),
    ).toBe(false);
    // Wrong user cannot answer another user's prompt.
    expect(service.postResponse(OTHER, claimed!.promptId, "x")).toBe(false);
  });

  it("ignores a duplicate post_response", async () => {
    const pending = service.enqueuePrompt(USER, "q", []);
    const claimed = await service.waitForPrompt(USER);
    expect(service.postResponse(USER, claimed!.promptId, "a")).toBe(true);
    expect(service.postResponse(USER, claimed!.promptId, "b")).toBe(false);
    await expect(pending).resolves.toEqual({ text: "a" });
  });

  describe("emitPendingAction", () => {
    const action = {
      actionId: "act-1",
      type: "create_transaction",
      expiresAt: Date.now() + 1000,
      descriptor: { type: "create_transaction" },
      signature: "sig",
      preview: {},
    } as any;

    it("returns false when the user has no in-flight prompt", () => {
      expect(service.emitPendingAction(USER, action)).toBe(false);
    });

    it("emits a pending_action event on the in-flight prompt's stream", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "add a transaction", [], emit);
      await service.waitForPrompt(USER);

      expect(service.emitPendingAction(USER, action)).toBe(true);
      expect(emit).toHaveBeenCalledWith({ type: "pending_action", action });
    });

    it("does not target another user's in-flight prompt", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "q", [], emit);
      await service.waitForPrompt(USER);

      expect(service.emitPendingAction(OTHER, action)).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });

    it("returns false when the in-flight prompt has no emit channel", async () => {
      service.enqueuePrompt(USER, "q", []);
      await service.waitForPrompt(USER);
      expect(service.emitPendingAction(USER, action)).toBe(false);
    });
  });

  describe("status", () => {
    it("is offline before any agent polls", () => {
      expect(service.getStatus(USER)).toEqual({ state: "offline", queued: 0 });
    });

    it("is busy while a claimed prompt is in flight", async () => {
      service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      expect(service.getStatus(USER).state).toBe("busy");
      service.postResponse(USER, claimed!.promptId, "a");
      // After responding, no longer busy; the recent poll keeps it "listening".
      expect(service.getStatus(USER).state).toBe("listening");
    });

    it("reports the queued count", () => {
      service.enqueuePrompt(USER, "a", []);
      service.enqueuePrompt(USER, "b", []);
      expect(service.getStatus(USER).queued).toBe(2);
    });
  });

  describe("timeouts", () => {
    it("returns null from a parked poll after the poll window", async () => {
      const poll = service.waitForPrompt(USER);
      jest.advanceTimersByTime(25 * 1000);
      await expect(poll).resolves.toBeNull();
    });

    it("rejects the browser prompt if no agent answers in time", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      jest.advanceTimersByTime(5 * 60 * 1000);
      await assertion;
    });
  });
});
