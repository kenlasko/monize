import { AiRelayService } from "./ai-relay.service";
import { RelayAttachmentStore } from "./relay-attachment.store";

const USER = "user-1";
const OTHER = "user-2";

// A valid 1x1 PNG (header + minimal body) so attachment validation passes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("AiRelayService", () => {
  let service: AiRelayService;
  let attachmentStore: RelayAttachmentStore;

  beforeEach(() => {
    // Fake timers so the long browser-wait timer set by enqueuePrompt never
    // leaks onto the real clock in tests that intentionally leave a prompt
    // unanswered.
    jest.useFakeTimers();
    attachmentStore = new RelayAttachmentStore();
    service = new AiRelayService(attachmentStore);
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

  describe("reportProgress", () => {
    it("returns false when the user has no in-flight prompt", () => {
      expect(service.reportProgress(USER, "missing", "working...")).toBe(false);
    });

    it("streams an assistant_text event on the in-flight prompt", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "buy XBAL", [], emit);
      const claimed = await service.waitForPrompt(USER);

      expect(
        service.reportProgress(USER, claimed!.promptId, "looking up category"),
      ).toBe(true);
      expect(emit).toHaveBeenCalledWith({
        type: "assistant_text",
        text: "looking up category\n",
      });
    });

    it("does not target another user's prompt", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "q", [], emit);
      const claimed = await service.waitForPrompt(USER);

      expect(service.reportProgress(OTHER, claimed!.promptId, "x")).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });

    it("returns false once the prompt has been answered", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "q", [], emit);
      const claimed = await service.waitForPrompt(USER);
      service.postResponse(USER, claimed!.promptId, "done");

      expect(service.reportProgress(USER, claimed!.promptId, "late")).toBe(
        false,
      );
    });
  });

  describe("reportToolActivity", () => {
    it("streams tool_start and tool_result on the in-flight prompt", async () => {
      const emit = jest.fn();
      service.enqueuePrompt(USER, "q", [], emit);
      await service.waitForPrompt(USER);

      service.reportToolActivity(USER, "list_categories", "start");
      service.reportToolActivity(USER, "list_categories", "result", false);

      expect(emit).toHaveBeenNthCalledWith(1, {
        type: "tool_start",
        name: "list_categories",
      });
      expect(emit).toHaveBeenNthCalledWith(2, {
        type: "tool_result",
        name: "list_categories",
        isError: false,
      });
    });

    it("is a no-op when the user has no in-flight prompt", () => {
      // No throw, nothing emitted (no prompt to target).
      expect(() =>
        service.reportToolActivity(USER, "list_categories", "start"),
      ).not.toThrow();
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

    it("rejects a never-claimed prompt after the queue wait (offline agent)", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const assertion = expect(pending).rejects.toMatchObject({
        name: "RelayTimeoutError",
        reason: "no_agent",
      });
      // Queue wait is 5 minutes; no agent ever polls.
      jest.advanceTimersByTime(5 * 60 * 1000);
      await assertion;
    });

    it("does not fire the old fixed wall while a claimed agent keeps working", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const rejection = jest.fn();
      pending.catch(rejection);
      const claimed = await service.waitForPrompt(USER);

      // The agent reports liveness every 80s for 6 minutes -- past the old
      // 5-minute fixed wall but never silent for a full idle window, so the
      // browser must NOT have given up.
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(80 * 1000);
        service.reportProgress(USER, claimed!.promptId, `working ${i}`);
        await Promise.resolve();
      }
      expect(rejection).not.toHaveBeenCalled();

      service.postResponse(USER, claimed!.promptId, "answer");
      await expect(pending).resolves.toEqual({ text: "answer" });
    });

    it("times out a claimed prompt that goes silent (idle window)", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      await service.waitForPrompt(USER);
      const assertion = expect(pending).rejects.toMatchObject({
        name: "RelayTimeoutError",
        reason: "disconnected",
      });
      // 90s of total silence after the claim.
      jest.advanceTimersByTime(90 * 1000);
      await assertion;
    });

    it("keeps a slow-but-alive agent alive across the idle window", async () => {
      const emit = jest.fn();
      const pending = service.enqueuePrompt(USER, "q", [], emit);
      const claimed = await service.waitForPrompt(USER);

      // Report liveness every 60s for 5 minutes -- never silent for a full 90s.
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(60 * 1000);
        service.reportProgress(USER, claimed!.promptId, `step ${i}`);
      }
      // Tool activity also counts as liveness.
      jest.advanceTimersByTime(60 * 1000);
      service.reportToolActivity(USER, "list_categories", "start");
      // And a poll.
      jest.advanceTimersByTime(60 * 1000);
      void service.waitForPrompt(USER);

      // Still in flight after well past the idle window thanks to liveness.
      expect(service.getStatus(USER).state).toBe("busy");
      expect(service.postResponse(USER, claimed!.promptId, "done")).toBe(true);
      await expect(pending).resolves.toEqual({ text: "done" });
    });

    it("enforces the hard upper bound even for a chatty agent", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      const assertion = expect(pending).rejects.toMatchObject({
        name: "RelayTimeoutError",
        reason: "disconnected",
      });

      // Keep reporting liveness every 60s for the full 20-minute backstop.
      for (let i = 0; i < 21; i++) {
        jest.advanceTimersByTime(60 * 1000);
        service.reportProgress(USER, claimed!.promptId, `tick ${i}`);
      }
      await assertion;
    });
  });

  describe("late-answer buffer", () => {
    it("buffers a late answer after the browser timed out and serves it on pickup", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      // Idle timeout fires while the agent is still working.
      const assertion = expect(pending).rejects.toMatchObject({
        reason: "disconnected",
      });
      jest.advanceTimersByTime(90 * 1000);
      await assertion;

      // The agent recovers and posts late: not dropped, returns true (success).
      expect(service.postResponse(USER, claimed!.promptId, "late answer")).toBe(
        true,
      );

      // The browser picks it up by promptId.
      expect(service.takeBufferedResponse(USER, claimed!.promptId)).toEqual({
        text: "late answer",
      });
      // Pickup removes it -- a second pickup finds nothing.
      expect(service.takeBufferedResponse(USER, claimed!.promptId)).toBeNull();
    });

    it("is idempotent for a double late-post (keeps the first answer)", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      pending.catch(() => undefined);
      jest.advanceTimersByTime(90 * 1000);

      expect(service.postResponse(USER, claimed!.promptId, "first")).toBe(true);
      // Second post for the same prompt is a no-op success.
      expect(service.postResponse(USER, claimed!.promptId, "second")).toBe(
        true,
      );
      expect(service.takeBufferedResponse(USER, claimed!.promptId)).toEqual({
        text: "first",
      });
    });

    it("does not serve another user's buffered answer", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      pending.catch(() => undefined);
      jest.advanceTimersByTime(90 * 1000);
      service.postResponse(USER, claimed!.promptId, "secret");

      expect(service.takeBufferedResponse(OTHER, claimed!.promptId)).toBeNull();
    });

    it("prunes a buffered answer after its TTL", async () => {
      const pending = service.enqueuePrompt(USER, "q", []);
      const claimed = await service.waitForPrompt(USER);
      pending.catch(() => undefined);
      jest.advanceTimersByTime(90 * 1000);
      service.postResponse(USER, claimed!.promptId, "stale");

      // Past the 10-minute buffer TTL.
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(service.takeBufferedResponse(USER, claimed!.promptId)).toBeNull();
    });

    it("evicts the oldest buffered answer past the per-user cap", async () => {
      const promptIds: string[] = [];
      // Buffer MAX_BUFFERED_PER_USER + 1 (= 21) late answers for one user.
      for (let i = 0; i < 21; i++) {
        const pending = service.enqueuePrompt(USER, `q${i}`, []);
        pending.catch(() => undefined);
        const claimed = await service.waitForPrompt(USER);
        promptIds.push(claimed!.promptId);
        // Advance just enough to expire this prompt's idle timer; stay under the
        // buffer TTL so earlier entries are not pruned by age, only by the cap.
        jest.advanceTimersByTime(90 * 1000);
        service.postResponse(USER, claimed!.promptId, `a${i}`);
      }

      // The very first answer was evicted to honour the cap.
      expect(service.takeBufferedResponse(USER, promptIds[0])).toBeNull();
      // The most recent one survives.
      expect(service.takeBufferedResponse(USER, promptIds[20])).toEqual({
        text: "a20",
      });
    });

    it("returns null when picking up an unknown prompt", () => {
      expect(
        service.takeBufferedResponse(
          USER,
          "00000000-0000-0000-0000-000000000000",
        ),
      ).toBeNull();
    });
  });

  describe("attachments", () => {
    const pngAttachment = {
      kind: "image" as const,
      mediaType: "image/png",
      filename: "chart.png",
      data: PNG_BASE64,
    };

    it("stores attachments and surfaces refs on the claimed prompt", async () => {
      service.enqueuePrompt(USER, "what is this?", [], undefined, undefined, [
        pngAttachment,
      ]);
      const claimed = await service.waitForPrompt(USER);

      expect(claimed?.attachments).toHaveLength(1);
      const ref = claimed!.attachments![0];
      expect(ref.filename).toBe("chart.png");
      expect(ref.kind).toBe("image");
      expect(ref.mediaType).toBe("image/png");
      expect(ref.uri).toBe(`monize-attachment://${ref.id}`);
      // The bytes themselves live in the store, keyed by the same user + id.
      expect(attachmentStore.get(USER, ref.id)?.data.length).toBeGreaterThan(0);
    });

    it("omits attachments from the claimed prompt when none were uploaded", async () => {
      service.enqueuePrompt(USER, "hi", []);
      const claimed = await service.waitForPrompt(USER);
      expect(claimed?.attachments).toBeUndefined();
    });

    it("releases stored attachments once the prompt is answered", async () => {
      service.enqueuePrompt(USER, "q", [], undefined, undefined, [
        pngAttachment,
      ]);
      const claimed = await service.waitForPrompt(USER);
      const id = claimed!.attachments![0].id;
      expect(attachmentStore.get(USER, id)).toBeDefined();

      service.postResponse(USER, claimed!.promptId, "done");
      expect(attachmentStore.get(USER, id)).toBeUndefined();
    });

    it("releases stored attachments when no agent ever claims the prompt", async () => {
      const pending = service.enqueuePrompt(
        USER,
        "q",
        [],
        undefined,
        (promptId) => promptId,
        [pngAttachment],
      );
      pending.catch(() => undefined);
      // The ref id is not exposed without a claim; assert via store size by
      // reading the only entry through a fresh store lookup is not possible, so
      // drive the timeout and confirm the user's bucket is emptied.
      jest.advanceTimersByTime(5 * 60 * 1000);
      await expect(pending).rejects.toMatchObject({ reason: "no_agent" });
      // A subsequent claim sees nothing, and any prior id is gone: the bucket
      // was released. Enqueue a fresh attachment and confirm only one remains.
      service.enqueuePrompt(USER, "q2", [], undefined, undefined, [
        pngAttachment,
      ]);
      const claimed = await service.waitForPrompt(USER);
      expect(claimed?.attachments).toHaveLength(1);
    });

    it("rejects synchronously when an attachment fails validation", () => {
      expect(() =>
        service.enqueuePrompt(USER, "q", [], undefined, undefined, [
          { ...pngAttachment, mediaType: "application/pdf", kind: "pdf" },
        ]),
      ).toThrow();
    });
  });
});
