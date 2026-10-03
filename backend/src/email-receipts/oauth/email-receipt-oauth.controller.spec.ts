import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ValidationPipe } from "@nestjs/common";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";
import {
  CompleteEmailReceiptOAuthDto,
  StartEmailReceiptOAuthDto,
} from "./dto/email-receipt-oauth.dto";
import { EmailReceiptOAuthController } from "./email-receipt-oauth.controller";

describe("EmailReceiptOAuthController", () => {
  const req = { user: { id: "user-1" } };
  const oauth = {
    providers: jest.fn(),
    start: jest.fn(),
    complete: jest.fn(),
    disconnect: jest.fn(),
  };
  const controller = new EmailReceiptOAuthController(oauth as never);
  const proto = EmailReceiptOAuthController.prototype;

  beforeEach(() => jest.clearAllMocks());

  it("lists the providers", () => {
    oauth.providers.mockReturnValue({ google: true });
    expect(controller.providers()).toEqual({ google: true });
  });

  it("starts for the JWT user, never for a user in the body", () => {
    oauth.start.mockReturnValue({ authorizationUrl: "https://x" });
    const dto = { provider: "google", userId: "someone-else" } as never;
    expect(controller.start(req, dto)).toEqual({
      authorizationUrl: "https://x",
    });
    expect(oauth.start).toHaveBeenCalledWith("user-1", dto);
  });

  it("completes for the JWT user", async () => {
    oauth.complete.mockResolvedValue({ id: "m1" });
    const dto = { code: "c", state: "s" } as never;
    await expect(controller.complete(req, dto)).resolves.toEqual({ id: "m1" });
    expect(oauth.complete).toHaveBeenCalledWith("user-1", dto);
  });

  it("disconnects for the JWT user and answers 204", async () => {
    oauth.disconnect.mockResolvedValue(undefined);
    await expect(controller.disconnect(req)).resolves.toBeUndefined();
    expect(oauth.disconnect).toHaveBeenCalledWith("user-1");
    expect(Reflect.getMetadata("__httpCode__", proto.disconnect)).toBe(204);
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptOAuthController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptOAuthController),
    ).toBe(false);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
      ).not.toBe(true);
    }
  });

  it("serves the routes of the contract", () => {
    expect(Reflect.getMetadata("path", EmailReceiptOAuthController)).toBe(
      "email-receipts/mailbox/oauth",
    );
    const path = (name: keyof typeof proto) =>
      Reflect.getMetadata("path", proto[name]);
    expect(path("providers")).toBe("providers");
    expect(path("start")).toBe("start");
    expect(path("complete")).toBe("complete");
  });

  it("throttles start and complete to 10 a minute", () => {
    const limitOf = (name: keyof typeof proto) =>
      Reflect.getMetadata("THROTTLER:LIMITdefault", proto[name]) as number;
    const ttlOf = (name: keyof typeof proto) =>
      Reflect.getMetadata("THROTTLER:TTLdefault", proto[name]) as number;
    expect(limitOf("start")).toBe(10);
    expect(limitOf("complete")).toBe(10);
    expect(ttlOf("start")).toBe(60000);
    expect(ttlOf("complete")).toBe(60000);
  });
});

describe("OAuth request validation", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const check = (metatype: new () => object, value: unknown) =>
    pipe.transform(value, { type: "body", metatype });

  it("accepts the two providers and nothing else", async () => {
    await expect(
      check(StartEmailReceiptOAuthDto, { provider: "google" }),
    ).resolves.toMatchObject({ provider: "google" });
    await expect(
      check(StartEmailReceiptOAuthDto, { provider: "microsoft" }),
    ).resolves.toMatchObject({ provider: "microsoft" });
    for (const body of [
      { provider: "yahoo" },
      { provider: "" },
      {},
      { provider: "google", extra: 1 },
      { provider: ["google"] },
    ]) {
      await expect(check(StartEmailReceiptOAuthDto, body)).rejects.toThrow();
    }
  });

  it("takes a code and a state of at most 4096 characters", async () => {
    await expect(
      check(CompleteEmailReceiptOAuthDto, {
        code: "4/0AbC-d_e",
        state: "x".repeat(4096),
      }),
    ).resolves.toMatchObject({ code: "4/0AbC-d_e" });
    for (const body of [
      { code: "c" },
      { state: "s" },
      { code: "", state: "s" },
      { code: "c", state: "" },
      { code: "x".repeat(4097), state: "s" },
      { code: "c", state: "x".repeat(4097) },
      { code: 1, state: "s" },
      { code: { a: 1 }, state: "s" },
      { code: "a\u0000b", state: "s" },
      { code: "c", state: "s", userId: "x" },
    ]) {
      await expect(check(CompleteEmailReceiptOAuthDto, body)).rejects.toThrow();
    }
  });
});
