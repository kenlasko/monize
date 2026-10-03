import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { EmailReceiptMailboxController } from "./email-receipt-mailbox.controller";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";

describe("EmailReceiptMailboxController", () => {
  const req = { user: { id: "user-1" } };
  const mailbox = {
    getView: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
    testConnection: jest.fn(),
    updateSettings: jest.fn(),
  };
  const poll = { pollNow: jest.fn() };
  const controller = new EmailReceiptMailboxController(
    mailbox as never,
    poll as never,
  );
  const proto = EmailReceiptMailboxController.prototype;

  beforeEach(() => jest.clearAllMocks());

  it("reads the JWT user's mailbox", async () => {
    mailbox.getView.mockResolvedValue({ id: "m1" });
    await expect(controller.get(req)).resolves.toEqual({ id: "m1" });
    expect(mailbox.getView).toHaveBeenCalledWith("user-1");
  });

  it("saves for the JWT user, never for a user in the body", async () => {
    mailbox.upsert.mockResolvedValue({ id: "m1" });
    const dto = { host: "h", userId: "someone-else" } as never;
    await controller.upsert(req, dto);
    expect(mailbox.upsert).toHaveBeenCalledWith("user-1", dto);
  });

  it("changes settings for the JWT user, never for a user in the body", async () => {
    mailbox.updateSettings.mockResolvedValue({ id: "m1" });
    const dto = { enabled: false, userId: "someone-else" } as never;
    await expect(controller.updateSettings(req, dto)).resolves.toEqual({
      id: "m1",
    });
    expect(mailbox.updateSettings).toHaveBeenCalledWith("user-1", dto);
    expect(Reflect.getMetadata("path", proto.updateSettings)).toBe("settings");
  });

  it("deletes for the JWT user", async () => {
    mailbox.remove.mockResolvedValue(undefined);
    await expect(controller.remove(req)).resolves.toBeUndefined();
    expect(mailbox.remove).toHaveBeenCalledWith("user-1");
  });

  it("tests a draft for the JWT user", async () => {
    mailbox.testConnection.mockResolvedValue({ ok: true, messages: 3 });
    const dto = { host: "h" } as never;
    await expect(controller.test(req, dto)).resolves.toEqual({
      ok: true,
      messages: 3,
    });
    expect(mailbox.testConnection).toHaveBeenCalledWith("user-1", dto);
  });

  it("polls now for the JWT user", async () => {
    const result = { ok: true, fetched: 2, skipped: 0, processed: 2 };
    poll.pollNow.mockResolvedValue(result);
    await expect(controller.pollNow(req)).resolves.toEqual(result);
    expect(poll.pollNow).toHaveBeenCalledWith("user-1");
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptMailboxController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptMailboxController),
    ).toBe(false);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
      ).not.toBe(true);
    }
  });

  it("throttles the connection test, the save and poll now", () => {
    const limitOf = (name: string) =>
      Reflect.getMetadata("THROTTLER:LIMITdefault", (proto as never)[name]) as
        | number
        | undefined;
    expect(limitOf("test")).toBe(5);
    expect(limitOf("pollNow")).toBe(3);
    expect(limitOf("upsert")).toBe(10);
    expect(limitOf("updateSettings")).toBe(20);
  });
});
