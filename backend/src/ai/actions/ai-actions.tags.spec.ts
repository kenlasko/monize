import { ConfigService } from "@nestjs/config";
import { AiActionsService } from "./ai-actions.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiActionBuilderService } from "./ai-action-builder.service";
import { AiWriteLimiter } from "./ai-write-limiter";
import { AiActionDescriptor } from "./ai-action.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";
import { createSingleUseTokenMock } from "../../test-helpers/single-use-token-testing";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";

const USER = "user-1";
const TAG = "d0000000-0000-4000-8000-000000000001";

/**
 * The tag cards `manage_tags` proposes: built by the real builder, signed by
 * the real signer and committed by the confirm endpoint's executors through
 * `TagsService`, with the REST DTOs' validation.
 */
describe("AiActionsService tag actions", () => {
  let service: AiActionsService;
  let builder: AiActionBuilderService;
  let signing: AiActionSigningService;
  let tags: Record<string, jest.Mock>;

  beforeEach(() => {
    signing = new AiActionSigningService({
      get: jest
        .fn()
        .mockReturnValue("test-secret-key-at-least-32-chars-long!!"),
    } as unknown as ConfigService);
    builder = new AiActionBuilderService(signing);
    tags = {
      create: jest.fn().mockResolvedValue({ id: TAG }),
      update: jest.fn().mockResolvedValue({ id: TAG }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    service = new AiActionsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      signing,
      new AiWriteLimiter(
        createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
      ),
      {} as never,
      {} as never,
      createSingleUseTokenMock() as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tags as never,
    );
  });

  const confirm = (descriptor: AiActionDescriptor) =>
    service.confirm(USER, {
      actionId: descriptor.actionId,
      signature: signing.sign(descriptor),
      descriptor: descriptor as unknown as Record<string, unknown>,
    } as ConfirmAiActionDto);

  it("creates a tag from its card", async () => {
    const card = builder.buildTagAction(USER, {
      name: "Trip",
      color: "#FF5733",
      icon: null,
    });
    expect(card.type).toBe("create_tag");
    expect(card.preview).toEqual({
      name: "Trip",
      tagColor: "#FF5733",
      tagIcon: null,
    });
    const result = await confirm(card.descriptor);
    expect(tags.create).toHaveBeenCalledWith(USER, {
      name: "Trip",
      color: "#FF5733",
    });
    expect(result).toEqual({ type: "create_tag", id: TAG });
  });

  it("writes only what an edit changes, clearing a colour with null", async () => {
    const card = builder.buildTagAction(USER, {
      tagId: TAG,
      currentName: "Trip",
      name: "Travel",
      color: null,
    });
    expect(card.descriptor).toMatchObject({
      type: "update_tag",
      tagId: TAG,
      name: "Travel",
      color: null,
    });
    expect(card.descriptor).not.toHaveProperty("icon");
    expect(card.preview).toMatchObject({
      name: "Travel",
      previousName: "Trip",
    });
    await confirm(card.descriptor);
    expect(tags.update).toHaveBeenCalledWith(USER, TAG, {
      name: "Travel",
      color: null,
    });
  });

  it("deletes the tag the card names", async () => {
    const card = builder.buildTagAction(USER, {
      tagId: TAG,
      name: "Trip",
      carriedCount: 4,
    });
    expect(card.preview).toEqual({ name: "Trip", tagCarriedCount: 4 });
    const result = await confirm(card.descriptor);
    expect(tags.remove).toHaveBeenCalledWith(USER, TAG);
    expect(result.id).toBe(TAG);
  });

  it("refuses a colour the REST DTO refuses, writing nothing", async () => {
    const card = builder.buildTagAction(USER, {
      name: "Trip",
      color: "red",
      icon: null,
    });
    await expect(confirm(card.descriptor)).rejects.toThrow();
    expect(tags.create).not.toHaveBeenCalled();
  });

  it("commits a batch row by row, skipping the one that fails", async () => {
    tags.create
      .mockResolvedValueOnce({ id: "t1" })
      .mockRejectedValueOnce(new Error("taken"))
      .mockResolvedValueOnce({ id: "t3" });
    const card = builder.buildBatchActions(
      USER,
      "create_tag",
      [
        { name: "A", color: null, icon: null },
        { name: "B", color: null, icon: null },
        { name: "C", color: null, icon: "star" },
      ],
      [],
    );
    const result = await confirm(card.descriptor);
    expect(tags.create).toHaveBeenCalledTimes(3);
    expect(tags.create).toHaveBeenLastCalledWith(USER, {
      name: "C",
      icon: "star",
    });
    expect(result.ids).toEqual(["t1", "t3"]);
    expect(result.skipped?.map((s) => s.index)).toEqual([1]);
  });
});
