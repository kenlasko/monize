import "reflect-metadata";
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";
import { EmailReceiptParsersController } from "./email-receipt-parsers.controller";

describe("EmailReceiptParsersController", () => {
  const req = { user: { id: "user-1" } };
  const parsers = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    approve: jest.fn(),
    test: jest.fn(),
  };
  const controller = new EmailReceiptParsersController(parsers as never);
  const ID = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";

  beforeEach(() => jest.clearAllMocks());

  it("acts for the JWT user on every call", async () => {
    const body = { userId: "someone-else" } as never;
    await controller.list(req);
    await controller.get(req, ID);
    await controller.create(req, body);
    await controller.update(req, ID, body);
    await controller.remove(req, ID);
    await controller.approve(req, ID, body);
    await controller.test(req, body);
    expect(parsers.list).toHaveBeenCalledWith("user-1");
    expect(parsers.get).toHaveBeenCalledWith("user-1", ID);
    expect(parsers.create).toHaveBeenCalledWith("user-1", body);
    expect(parsers.update).toHaveBeenCalledWith("user-1", ID, body);
    expect(parsers.remove).toHaveBeenCalledWith("user-1", ID);
    expect(parsers.approve).toHaveBeenCalledWith("user-1", ID, body);
    expect(parsers.test).toHaveBeenCalledWith("user-1", body);
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptParsersController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptParsersController),
    ).toBe(false);
    const proto = EmailReceiptParsersController.prototype as unknown as Record<
      string,
      (...args: never[]) => unknown
    >;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[name])).not.toBe(
        true,
      );
    }
  });

  it("parses every :id with ParseUUIDPipe", () => {
    const routes = ["get", "update", "remove", "approve"];
    for (const name of routes) {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        EmailReceiptParsersController,
        name,
      ) as Record<string, { data?: string; pipes: unknown[] }>;
      const idArg = Object.values(args).find((a) => a.data === "id");
      expect(idArg?.pipes).toContain(ParseUUIDPipe);
    }
  });
});
