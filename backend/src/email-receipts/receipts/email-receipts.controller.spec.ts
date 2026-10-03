import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";
import { AskAiEmailReceiptDto } from "./dto/email-receipts.dto";
import { EmailReceiptsController } from "./email-receipts.controller";

describe("EmailReceiptsController", () => {
  const req = { user: { id: "user-1" } };
  const receipts = {
    list: jest.fn(),
    get: jest.fn(),
    reprocess: jest.fn(),
    link: jest.fn(),
    ignore: jest.fn(),
    remove: jest.fn(),
  };
  const ai = { askAi: jest.fn(), draftParser: jest.fn() };
  const controller = new EmailReceiptsController(
    receipts as never,
    ai as never,
  );
  const proto = EmailReceiptsController.prototype as unknown as Record<
    string,
    (...args: never[]) => unknown
  >;
  const ID = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";

  beforeEach(() => jest.clearAllMocks());

  it("lists for the JWT user with the status and limit of the query", async () => {
    receipts.list.mockResolvedValue([]);
    await controller.list(req, { status: "review", limit: 10 } as never);
    expect(receipts.list).toHaveBeenCalledWith("user-1", {
      status: "review",
      limit: 10,
    });
  });

  it.each([
    ["get", "get"],
    ["reprocess", "reprocess"],
    ["ignore", "ignore"],
    ["remove", "remove"],
  ] as const)("%s acts for the JWT user on the id", async (method, service) => {
    await (controller[method] as (r: unknown, id: string) => Promise<unknown>)(
      req,
      ID,
    );
    expect(receipts[service]).toHaveBeenCalledWith("user-1", ID);
  });

  it("links with the transaction of the body, never a user of the body", async () => {
    await controller.link(req, ID, {
      transactionId: "t1",
      userId: "someone-else",
    } as never);
    expect(receipts.link).toHaveBeenCalledWith("user-1", ID, "t1");
  });

  it("asks the AI with the chosen transaction of the body, never a user of the body", async () => {
    await controller.askAi(req, ID, {
      transactionId: "t1",
      userId: "someone-else",
    } as never);
    expect(ai.askAi).toHaveBeenCalledWith("user-1", ID, "t1");
  });

  it.each([{}, { transactionId: null }, { transactionId: "" }])(
    "asks the AI about the email's own transaction for the body %j",
    async (body) => {
      await controller.askAi(req, ID, body as never);
      expect(ai.askAi).toHaveBeenCalledWith("user-1", ID, null);
    },
  );

  it("drafts a parser for the JWT user", async () => {
    await controller.draftParser(req, ID);
    expect(ai.draftParser).toHaveBeenCalledWith("user-1", ID);
  });

  describe("the ask-ai body", () => {
    const check = (body: object) =>
      validate(plainToInstance(AskAiEmailReceiptDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it.each([
      {},
      { transactionId: null },
      { transactionId: "" },
      { transactionId: ID },
    ])("accepts %j", async (body) => {
      expect(await check(body)).toHaveLength(0);
    });

    it.each([
      { transactionId: "not-a-uuid" },
      { transactionId: 5 },
      { transactionId: ID, userId: "x" },
      { unknown: true },
    ])("refuses %j", async (body) => {
      expect((await check(body)).length).toBeGreaterThan(0);
    });
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptsController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptsController),
    ).toBe(false);
    for (const name of Object.getOwnPropertyNames(
      EmailReceiptsController.prototype,
    )) {
      if (name === "constructor") continue;
      expect(Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[name])).not.toBe(
        true,
      );
    }
  });

  it("parses every :id with ParseUUIDPipe", () => {
    const routes = Object.getOwnPropertyNames(
      EmailReceiptsController.prototype,
    ).filter((name) => name !== "constructor" && name !== "list");
    expect(routes).toHaveLength(7);
    for (const name of routes) {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        EmailReceiptsController,
        name,
      ) as Record<string, { data?: string; pipes: unknown[] }>;
      const idArg = Object.values(args).find((a) => a.data === "id");
      expect(idArg).toBeDefined();
      expect(idArg?.pipes).toContain(ParseUUIDPipe);
    }
  });

  it("throttles the AI routes tightly", () => {
    const limitOf = (name: string) =>
      Reflect.getMetadata("THROTTLER:LIMITdefault", proto[name]) as
        | number
        | undefined;
    expect(limitOf("askAi")).toBe(10);
    expect(limitOf("draftParser")).toBe(5);
  });
});
