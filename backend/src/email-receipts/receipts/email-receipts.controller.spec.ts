import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";
import {
  ApprovableEmailReceiptsDto,
  AskAiEmailReceiptDto,
  BulkEmailReceiptFilterDto,
  BulkEmailReceiptsDto,
  BulkReprocessEmailReceiptsDto,
  CountEmailReceiptsDto,
  EMAIL_RECEIPTS_MAX_SEARCH_CHARS,
  EmailReceiptStatusCountsDto,
  ListEmailReceiptDomainsDto,
  ListEmailReceiptsDto,
  ProcessBatchEmailReceiptsDto,
  ProfileBatchEmailReceiptsDto,
} from "./dto/email-receipts.dto";
import { EmailReceiptsController } from "./email-receipts.controller";

describe("EmailReceiptsController", () => {
  const req = { user: { id: "user-1" } };
  const receipts = {
    list: jest.fn(),
    listDomains: jest.fn(),
    listUncoveredDomains: jest.fn(),
    overview: jest.fn(),
    statusCounts: jest.fn(),
    processBatch: jest.fn(),
    bulk: jest.fn(),
    countSelection: jest.fn(),
    reprocessSelection: jest.fn(),
    approvableSelection: jest.fn(),
    get: jest.fn(),
    reprocess: jest.fn(),
    link: jest.fn(),
    ignore: jest.fn(),
    remove: jest.fn(),
  };
  const ai = { askAi: jest.fn() };
  const profileBatches = { run: jest.fn() };
  const controller = new EmailReceiptsController(
    receipts as never,
    ai as never,
    profileBatches as never,
  );
  const proto = EmailReceiptsController.prototype as unknown as Record<
    string,
    (...args: never[]) => unknown
  >;
  const ID = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";

  beforeEach(() => jest.clearAllMocks());

  it("lists for the JWT user with the status and limit of the query", async () => {
    receipts.list.mockResolvedValue([]);
    await controller.list(req, {
      status: "review",
      limit: 10,
      offset: 50,
    } as never);
    expect(receipts.list).toHaveBeenCalledWith("user-1", {
      status: "review",
      domain: undefined,
      limit: 10,
      offset: 50,
    });
  });

  it("lists with the domain of the query as well, still for the JWT user", async () => {
    receipts.list.mockResolvedValue([]);
    await controller.list(req, {
      status: "review",
      domain: "shop.example.com",
      userId: "someone-else",
    } as never);
    expect(receipts.list).toHaveBeenCalledWith("user-1", {
      status: "review",
      domain: "shop.example.com",
      limit: undefined,
      offset: undefined,
    });
  });

  const SEARCH = {
    search: "invoice",
    searchIn: "subject",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
  } as const;

  it("forwards the search and the dates of the list, domains and status-counts queries", async () => {
    receipts.list.mockResolvedValue([]);
    receipts.listDomains.mockResolvedValue([]);
    receipts.statusCounts.mockResolvedValue({});
    await controller.list(req, { status: "review", ...SEARCH } as never);
    await controller.domains(req, { status: "review", ...SEARCH } as never);
    await controller.statusCounts(req, {
      domain: "shop.example.com",
      ...SEARCH,
    } as never);
    expect(receipts.list).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining(SEARCH),
    );
    expect(receipts.listDomains).toHaveBeenCalledWith("user-1", {
      status: "review",
      ...SEARCH,
    });
    expect(receipts.statusCounts).toHaveBeenCalledWith("user-1", {
      domain: "shop.example.com",
      ...SEARCH,
    });
  });

  it("forwards the search and the dates of a bulk filter, beside receivedFrom", async () => {
    receipts.bulk.mockResolvedValue({});
    await controller.bulk(req, {
      action: "ignore",
      expectedCount: 3,
      filter: { receivedFrom: "2026-02-01", ...SEARCH },
    } as never);
    expect(receipts.bulk).toHaveBeenCalledWith(
      "user-1",
      "ignore",
      {
        filter: expect.objectContaining({
          receivedFrom: "2026-02-01",
          ...SEARCH,
        }),
      },
      3,
    );
  });

  describe("the search fields", () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    const errorsOf = async (
      cls: new () => object,
      query: object,
    ): Promise<number> =>
      (await validate(plainToInstance(cls, query), opts)).length;

    it.each([
      ListEmailReceiptsDto,
      ListEmailReceiptDomainsDto,
      EmailReceiptStatusCountsDto,
      BulkEmailReceiptFilterDto,
    ])("%p accepts a search, a field and a date range", async (cls) => {
      expect(await errorsOf(cls, SEARCH)).toBe(0);
      expect(
        await errorsOf(cls, { dateFrom: "2026-01-31", dateTo: "2026-01-31" }),
      ).toBe(0);
    });

    it("trims the search and reads a blank one as none", async () => {
      expect(
        plainToInstance(ListEmailReceiptsDto, { search: "  a b " }).search,
      ).toBe("a b");
      const blank = plainToInstance(ListEmailReceiptsDto, { search: "   " });
      expect(blank.search).toBeUndefined();
      expect(await validate(blank, opts)).toHaveLength(0);
      expect(await errorsOf(ListEmailReceiptsDto, { search: "" })).toBe(0);
    });

    it("limits the search to 200 characters after trimming", async () => {
      expect(EMAIL_RECEIPTS_MAX_SEARCH_CHARS).toBe(200);
      const max = "x".repeat(200);
      expect(await errorsOf(ListEmailReceiptsDto, { search: ` ${max} ` })).toBe(
        0,
      );
      expect(await errorsOf(ListEmailReceiptsDto, { search: max + "x" })).toBe(
        1,
      );
    });

    it.each(["a\u0000b", "a\u001bb", "a\u007fb", 5, ["a", "b"]])(
      "refuses the search %j",
      async (search) => {
        expect(await errorsOf(ListEmailReceiptsDto, { search })).toBe(1);
      },
    );

    it("refuses a search field that is not all, subject, sender or body", async () => {
      expect(await errorsOf(ListEmailReceiptsDto, { searchIn: "title" })).toBe(
        1,
      );
      for (const searchIn of ["all", "subject", "sender", "body"]) {
        expect(await errorsOf(ListEmailReceiptsDto, { searchIn })).toBe(0);
      }
    });

    it.each(["2026-13-01", "2026-02-30", "01/02/2026", "2026-1-1"])(
      "refuses the date %j",
      async (dateFrom) => {
        expect(await errorsOf(ListEmailReceiptsDto, { dateFrom })).toBe(1);
        expect(await errorsOf(ListEmailReceiptsDto, { dateTo: dateFrom })).toBe(
          1,
        );
      },
    );

    it("refuses an end date before the start date, on every query", async () => {
      const range = { dateFrom: "2026-02-01", dateTo: "2026-01-31" };
      for (const cls of [
        ListEmailReceiptsDto,
        ListEmailReceiptDomainsDto,
        EmailReceiptStatusCountsDto,
        BulkEmailReceiptFilterDto,
      ]) {
        expect(await errorsOf(cls, range)).toBe(1);
      }
    });

    it("accepts blank dates, as the other optional fields of the module do", async () => {
      expect(
        await errorsOf(ListEmailReceiptsDto, { dateFrom: "", dateTo: "" }),
      ).toBe(0);
    });
  });

  it("lists the sender domains for the JWT user", async () => {
    receipts.listDomains.mockResolvedValue([
      { domain: "a.example.com", count: 2 },
    ]);
    await expect(controller.domains(req, {} as never)).resolves.toEqual([
      { domain: "a.example.com", count: 2 },
    ]);
    expect(receipts.listDomains).toHaveBeenCalledWith("user-1", {
      status: undefined,
    });
  });

  it("counts the domains of one status only, for the JWT user", async () => {
    receipts.listDomains.mockResolvedValue([]);
    await controller.domains(req, {
      status: "review",
      userId: "someone-else",
    } as never);
    expect(receipts.listDomains).toHaveBeenCalledWith("user-1", {
      status: "review",
    });
  });

  it("answers the status counts for the JWT user, optionally of one domain", async () => {
    receipts.statusCounts.mockResolvedValue({
      total: 3,
      byStatus: { review: 3 },
    });
    await expect(
      controller.statusCounts(req, { domain: "shop.example.com" } as never),
    ).resolves.toEqual({ total: 3, byStatus: { review: 3 } });
    expect(receipts.statusCounts).toHaveBeenCalledWith("user-1", {
      domain: "shop.example.com",
    });
  });

  it("declares the domains route before :id, so the literal segment is matched first", () => {
    const names = Object.getOwnPropertyNames(EmailReceiptsController.prototype);
    expect(names.indexOf("domains")).toBeGreaterThan(-1);
    expect(names.indexOf("domains")).toBeLessThan(names.indexOf("get"));
    expect(Reflect.getMetadata("path", proto.domains)).toBe("domains");
  });

  it("answers the uncovered domains for the JWT user, on a literal route declared before :id", async () => {
    receipts.listUncoveredDomains.mockResolvedValue([
      { domain: "a.example.com", count: 3, draftParserId: null },
    ]);
    await expect(controller.uncoveredDomains(req)).resolves.toEqual([
      { domain: "a.example.com", count: 3, draftParserId: null },
    ]);
    expect(receipts.listUncoveredDomains).toHaveBeenCalledWith("user-1");
    const names = Object.getOwnPropertyNames(EmailReceiptsController.prototype);
    expect(names.indexOf("uncoveredDomains")).toBeLessThan(
      names.indexOf("get"),
    );
    expect(Reflect.getMetadata("path", proto.uncoveredDomains)).toBe(
      "domains/uncovered",
    );
  });

  describe("the domains and status-counts queries", () => {
    it("accepts a known status and refuses an unknown one", async () => {
      const ok = await validate(
        plainToInstance(ListEmailReceiptDomainsDto, { status: "review" }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      const bad = await validate(
        plainToInstance(ListEmailReceiptDomainsDto, { status: "bogus" }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      expect(ok).toHaveLength(0);
      expect(bad).not.toHaveLength(0);
    });

    it("normalises and validates the domain of status-counts", async () => {
      const dto = plainToInstance(EmailReceiptStatusCountsDto, {
        domain: " Shop.Example.com ",
      });
      expect(dto.domain).toBe("shop.example.com");
      const bad = await validate(
        plainToInstance(EmailReceiptStatusCountsDto, {
          domain: "not a domain",
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      expect(bad).not.toHaveLength(0);
    });

    it("declares status-counts before :id", () => {
      const names = Object.getOwnPropertyNames(
        EmailReceiptsController.prototype,
      );
      expect(names.indexOf("statusCounts")).toBeLessThan(names.indexOf("get"));
      expect(Reflect.getMetadata("path", proto.statusCounts)).toBe(
        "status-counts",
      );
    });
  });

  describe("the list query", () => {
    const check = async (query: object) => {
      const dto = plainToInstance(ListEmailReceiptsDto, query);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return { dto, errors };
    };

    it("accepts no domain, and a host name", async () => {
      expect((await check({})).errors).toHaveLength(0);
      expect((await check({ domain: "shop.example.com" })).errors).toHaveLength(
        0,
      );
    });

    it("lower-cases and trims the domain, drops a leading @ and a trailing dot", async () => {
      const { dto, errors } = await check({ domain: "  @Shop.Example.COM. " });
      expect(errors).toHaveLength(0);
      expect(dto.domain).toBe("shop.example.com");
    });

    it("keeps only the domain of a sender address", async () => {
      const { dto, errors } = await check({ domain: "orders@B.Example.com" });
      expect(errors).toHaveLength(0);
      expect(dto.domain).toBe("b.example.com");
    });

    it.each([
      "not a domain",
      "nodots",
      "a%.example.com",
      "a_b.example.com",
      "shop.example.com/path",
      "x".repeat(250) + ".com",
      "",
      5,
      ["a.example.com"],
    ])("refuses the domain %j", async (domain) => {
      expect((await check({ domain })).errors.length).toBeGreaterThan(0);
    });

    it("accepts an offset from 0 to 100000, read from the query string", async () => {
      expect((await check({})).dto.offset).toBeUndefined();
      expect((await check({ offset: "50" })).dto.offset).toBe(50);
      for (const offset of [0, 100000]) {
        expect((await check({ offset })).errors).toHaveLength(0);
      }
    });

    it.each([-1, 100001, 1.5, "abc"])(
      "refuses the offset %j",
      async (offset) => {
        expect((await check({ offset })).errors.length).toBeGreaterThan(0);
      },
    );

    it("refuses a key the query does not have", async () => {
      expect((await check({ userId: "x" })).errors.length).toBeGreaterThan(0);
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
    expect(ai.askAi).toHaveBeenCalledWith("user-1", ID, "t1", {
      asTrade: false,
    });
  });

  it.each([{}, { transactionId: null }, { transactionId: "" }])(
    "asks the AI about the email's own transaction for the body %j",
    async (body) => {
      await controller.askAi(req, ID, body as never);
      expect(ai.askAi).toHaveBeenCalledWith("user-1", ID, null, {
        asTrade: false,
      });
    },
  );

  it("asks the AI to recognize the email as a trade only when the body says so", async () => {
    await controller.askAi(req, ID, { asTrade: true } as never);
    expect(ai.askAi).toHaveBeenCalledWith("user-1", ID, null, {
      asTrade: true,
    });
  });

  it("answers the overview for the JWT user", async () => {
    receipts.overview.mockResolvedValue({ parsers: { approved: 1, draft: 0 } });
    expect(await controller.overview(req)).toEqual({
      parsers: { approved: 1, draft: 0 },
    });
    expect(receipts.overview).toHaveBeenCalledWith("user-1");
  });

  it("processes in bulk for the JWT user with exactly the fields of the body", async () => {
    receipts.processBatch.mockResolvedValue({ processed: 2 });
    await controller.processBatch(req, {
      domain: "shop.example.com",
      statuses: ["pending"],
      limit: 20,
      since: "2026-10-04T12:00:00.000000Z",
      userId: "someone-else",
    } as never);
    expect(receipts.processBatch).toHaveBeenCalledWith("user-1", {
      domain: "shop.example.com",
      statuses: ["pending"],
      limit: 20,
      since: "2026-10-04T12:00:00.000000Z",
    });
  });

  it("registers overview and process-batch before :id, and throttles the bulk route", () => {
    const names = Object.getOwnPropertyNames(EmailReceiptsController.prototype);
    expect(names.indexOf("overview")).toBeLessThan(names.indexOf("get"));
    expect(names.indexOf("processBatch")).toBeLessThan(names.indexOf("get"));
    expect(
      Reflect.getMetadata("THROTTLER:LIMITdefault", proto.processBatch),
    ).toBe(30);
  });

  it("runs a profile's bulk action for the JWT user with the fields of the body", async () => {
    profileBatches.run.mockResolvedValue({ matched: 0 });
    await controller.profileBatch(req, {
      parserId: ID,
      action: "ignore",
      after: ID,
      userId: "someone-else",
    } as never);
    expect(profileBatches.run).toHaveBeenCalledWith("user-1", ID, "ignore", ID);
    const names = Object.getOwnPropertyNames(EmailReceiptsController.prototype);
    expect(names.indexOf("profileBatch")).toBeLessThan(names.indexOf("get"));
    expect(
      Reflect.getMetadata("THROTTLER:LIMITdefault", proto.profileBatch),
    ).toBe(60);
  });

  describe("the profile-batch body", () => {
    const check = async (body: object) =>
      validate(plainToInstance(ProfileBatchEmailReceiptsDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it.each([
      { parserId: ID, action: "count" },
      { parserId: ID, action: "ignore", after: ID },
      { parserId: ID, action: "delete" },
    ])("accepts %j", async (body) => {
      expect(await check(body)).toHaveLength(0);
    });

    it.each([
      {},
      { action: "count" },
      { parserId: "not-a-uuid", action: "count" },
      { parserId: ID, action: "archive" },
      { parserId: ID, action: "count", after: "x" },
      { parserId: ID, action: "count", userId: "someone-else" },
    ])("refuses %j", async (body) => {
      expect((await check(body)).length).toBeGreaterThan(0);
    });
  });

  describe("the process-batch body", () => {
    const check = async (body: object) =>
      validate(plainToInstance(ProcessBatchEmailReceiptsDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it.each([
      {},
      { domain: "Shop.Example.com" },
      { domain: "orders@shop.example.com" },
      { statuses: ["pending", "no_parser", "parse_failed"] },
      {
        statuses: [
          "pending",
          "no_parser",
          "parse_failed",
          "unmatched",
          "ambiguous",
          "review_conflict",
        ],
      },
      { limit: 1 },
      { limit: 200 },
      { since: "2026-10-04T12:00:00.123456Z" },
    ])("accepts %j", async (body) => {
      expect(await check(body)).toHaveLength(0);
    });

    it.each([
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: "20" },
      { statuses: ["review"] },
      { statuses: ["ignored"] },
      { statuses: ["pending", "pending"] },
      { statuses: "pending" },
      { statuses: [].concat(Array(7).fill("pending") as never) },
      { domain: "not a domain" },
      { since: "yesterday" },
      { since: 5 },
      { userId: "x" },
      { unknown: true },
    ])("refuses %j", async (body) => {
      expect((await check(body)).length).toBeGreaterThan(0);
    });
  });

  it("has no synchronous draft-parser route: parsers are drafted through the chat", () => {
    expect(
      (controller as unknown as Record<string, unknown>).draftParser,
    ).toBeUndefined();
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

  describe("the bulk route", () => {
    const UUID_A = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
    const UUID_B = "1b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a12";

    const check = async (body: object) => {
      const dto = plainToInstance(BulkEmailReceiptsDto, body);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return { dto, errors };
    };

    it("is a POST declared before :id, throttled to 10 a minute, answering 200", () => {
      const names = Object.getOwnPropertyNames(
        EmailReceiptsController.prototype,
      );
      expect(names.indexOf("bulk")).toBeLessThan(names.indexOf("get"));
      expect(Reflect.getMetadata("path", proto.bulk)).toBe("bulk");
      expect(Reflect.getMetadata("method", proto.bulk)).toBe(1); // POST
      expect(Reflect.getMetadata("THROTTLER:LIMITdefault", proto.bulk)).toBe(
        10,
      );
      expect(Reflect.getMetadata("__httpCode__", proto.bulk)).toBe(200);
    });

    it("sends ids to the service for the JWT user only", async () => {
      receipts.bulk.mockResolvedValue({ affected: 2 });
      const out = await controller.bulk(req, {
        action: "delete",
        ids: [UUID_A, UUID_B],
        expectedCount: 2,
        userId: "someone-else",
      } as never);
      expect(out).toEqual({ affected: 2 });
      expect(receipts.bulk).toHaveBeenCalledWith(
        "user-1",
        "delete",
        { ids: [UUID_A, UUID_B] },
        2,
      );
    });

    it("sends a filter to the service", async () => {
      receipts.bulk.mockResolvedValue({ affected: 9 });
      await controller.bulk(req, {
        action: "ignore",
        filter: { status: "no_parser", domain: "gmail.com" },
        expectedCount: 9,
      } as never);
      expect(receipts.bulk).toHaveBeenCalledWith(
        "user-1",
        "ignore",
        { filter: { status: "no_parser", domain: "gmail.com" } },
        9,
      );
    });

    it.each([
      { action: "delete", ids: [UUID_A], expectedCount: 1 },
      { action: "ignore", ids: [UUID_A, UUID_B], expectedCount: 2 },
      { action: "delete", filter: {}, expectedCount: 20000 },
      {
        action: "ignore",
        filter: { status: "unmatched", domain: " Gmail.com " },
        expectedCount: 3,
      },
    ])("accepts %j", async (body) => {
      expect((await check(body)).errors).toHaveLength(0);
    });

    it("normalises the filter domain like the list does", async () => {
      const { dto } = await check({
        action: "delete",
        filter: { domain: " @Gmail.COM. " },
        expectedCount: 1,
      });
      expect(dto.filter?.domain).toBe("gmail.com");
    });

    it.each([
      ["neither ids nor filter", { action: "delete", expectedCount: 1 }],
      [
        "both ids and filter",
        {
          action: "delete",
          ids: [UUID_A],
          filter: { domain: "gmail.com" },
          expectedCount: 1,
        },
      ],
      ["an empty ids list", { action: "delete", ids: [], expectedCount: 1 }],
      [
        "a null ids list with no filter",
        { action: "delete", ids: null, expectedCount: 1 },
      ],
      ["a non-UUID id", { action: "delete", ids: ["nope"], expectedCount: 1 }],
      [
        "a repeated id",
        { action: "delete", ids: [UUID_A, UUID_A], expectedCount: 2 },
      ],
      [
        "501 ids",
        {
          action: "delete",
          ids: Array.from(
            { length: 501 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          ),
          expectedCount: 501,
        },
      ],
      [
        "an unknown action",
        { action: "archive", ids: [UUID_A], expectedCount: 1 },
      ],
      ["no action", { ids: [UUID_A], expectedCount: 1 }],
      ["no expectedCount", { action: "delete", ids: [UUID_A] }],
      [
        "a zero expectedCount",
        { action: "delete", ids: [UUID_A], expectedCount: 0 },
      ],
      [
        "an expectedCount above 20000",
        { action: "delete", filter: {}, expectedCount: 20001 },
      ],
      [
        "a fractional expectedCount",
        { action: "delete", ids: [UUID_A], expectedCount: 1.5 },
      ],
      [
        "an unknown status in the filter",
        {
          action: "delete",
          filter: { status: "bogus" },
          expectedCount: 1,
        },
      ],
      [
        "a bad domain in the filter",
        {
          action: "delete",
          filter: { domain: "not a domain" },
          expectedCount: 1,
        },
      ],
      [
        "an unknown field in the filter",
        {
          action: "delete",
          filter: { userId: "x" },
          expectedCount: 1,
        },
      ],
      [
        "an unknown field in the body",
        { action: "delete", ids: [UUID_A], expectedCount: 1, userId: "x" },
      ],
      [
        "a filter that is not an object",
        { action: "delete", filter: "gmail.com", expectedCount: 1 },
      ],
    ])("refuses %s", async (_name, body) => {
      expect((await check(body as object)).errors).not.toHaveLength(0);
    });

    it("accepts exactly 500 ids", async () => {
      const ids = Array.from(
        { length: 500 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      expect(
        (await check({ action: "delete", ids, expectedCount: 500 })).errors,
      ).toHaveLength(0);
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
    ).filter(
      (name) =>
        ![
          "constructor",
          "list",
          "domains",
          "uncoveredDomains",
          "overview",
          "statusCounts",
          "processBatch",
          "profileBatch",
          "bulk",
          "bulkCount",
          "bulkReprocess",
          "bulkApprovable",
        ].includes(name),
    );
    expect(routes).toHaveLength(6);
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
        number | undefined;
    expect(limitOf("askAi")).toBe(10);
  });
});

describe("the selection routes under bulk/", () => {
  const UUID_A = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
  const req = { user: { id: "user-1" } };
  const receipts = {
    countSelection: jest.fn(),
    reprocessSelection: jest.fn(),
    approvableSelection: jest.fn(),
  };
  const controller = new EmailReceiptsController(
    receipts as never,
    { askAi: jest.fn() } as never,
    { run: jest.fn() } as never,
  );
  const proto = EmailReceiptsController.prototype as unknown as Record<
    string,
    (...args: never[]) => unknown
  >;
  beforeEach(() => jest.clearAllMocks());

  const check = async <T extends object>(
    cls: new () => T,
    body: object,
  ): Promise<{ dto: T; errors: unknown[] }> => {
    const dto = plainToInstance(cls, body);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return { dto, errors };
  };

  it.each([
    ["bulkCount", "bulk/count", 60],
    ["bulkReprocess", "bulk/reprocess", 60],
    ["bulkApprovable", "bulk/approvable", 30],
  ])(
    "%s is a POST on %s declared before :id, throttled to %i a minute, answering 200",
    (name, path, limit) => {
      const names = Object.getOwnPropertyNames(
        EmailReceiptsController.prototype,
      );
      expect(names.indexOf(name)).toBeLessThan(names.indexOf("get"));
      expect(Reflect.getMetadata("path", proto[name])).toBe(path);
      expect(Reflect.getMetadata("method", proto[name])).toBe(1);
      expect(Reflect.getMetadata("THROTTLER:LIMITdefault", proto[name])).toBe(
        limit,
      );
      expect(Reflect.getMetadata("__httpCode__", proto[name])).toBe(200);
    },
  );

  it("counts a filter, new fields included, for the JWT user", async () => {
    receipts.countSelection.mockResolvedValue({ count: 4 });
    const filter = {
      status: "review",
      excludeStatuses: ["ignored"],
      excludeDomains: ["gmail.com"],
      receivedFrom: "2026-01-01",
      receivedTo: "2026-02-01",
    };
    await expect(
      controller.bulkCount(req, { filter } as never),
    ).resolves.toEqual({ count: 4 });
    expect(receipts.countSelection).toHaveBeenCalledWith("user-1", filter);
  });

  it("reprocesses ids or a filter with its options", async () => {
    receipts.reprocessSelection.mockResolvedValue({ remaining: 0 });
    await controller.bulkReprocess(req, {
      ids: [UUID_A],
      onlyStatuses: ["ignored"],
      since: "2026-10-01T00:00:00Z",
      limit: 5,
    } as never);
    expect(receipts.reprocessSelection).toHaveBeenCalledWith(
      "user-1",
      { ids: [UUID_A] },
      { onlyStatuses: ["ignored"], since: "2026-10-01T00:00:00Z", limit: 5 },
    );
    await controller.bulkReprocess(req, {
      filter: { domain: "gmail.com" },
    } as never);
    expect(receipts.reprocessSelection).toHaveBeenLastCalledWith(
      "user-1",
      { filter: expect.objectContaining({ domain: "gmail.com" }) },
      { onlyStatuses: undefined, since: undefined, limit: undefined },
    );
  });

  it("lists the approvable proposals of ids or a filter", async () => {
    receipts.approvableSelection.mockResolvedValue({
      requestIds: ["r1"],
      trades: 2,
    });
    await expect(
      controller.bulkApprovable(req, { ids: [UUID_A] } as never),
    ).resolves.toEqual({ requestIds: ["r1"], trades: 2 });
    expect(receipts.approvableSelection).toHaveBeenCalledWith("user-1", {
      ids: [UUID_A],
    });
  });

  describe("the filter of every selection body", () => {
    const manyDomains = Array.from(
      { length: 51 },
      (_, i) => `d${i}.example.com`,
    );
    it.each([
      ["a state to exclude", { excludeStatuses: ["ignored", "review"] }],
      ["a domain to exclude, normalised", { excludeDomains: [" @Gmail.com "] }],
      [
        "a date range",
        { receivedFrom: "2026-01-31", receivedTo: "2026-01-31" },
      ],
      ["only a start", { receivedFrom: "2026-01-31" }],
    ])("accepts %s", async (_n, filter) => {
      const { dto, errors } = await check(CountEmailReceiptsDto, { filter });
      expect(errors).toHaveLength(0);
      if ("excludeDomains" in filter) {
        expect(dto.filter.excludeDomains).toEqual(["gmail.com"]);
      }
    });

    it.each([
      ["an unknown excluded state", { excludeStatuses: ["bogus"] }],
      ["a repeated excluded state", { excludeStatuses: ["review", "review"] }],
      [
        "more excluded states than there are",
        {
          excludeStatuses: [
            "pending",
            "skipped",
            "no_parser",
            "parse_failed",
            "unmatched",
            "ambiguous",
            "review_conflict",
            "review",
            "ignored",
            "ignored",
          ],
        },
      ],
      ["excluded states that are not a list", { excludeStatuses: "review" }],
      ["a bad excluded domain", { excludeDomains: ["not a domain"] }],
      ["51 excluded domains", { excludeDomains: manyDomains }],
      ["a repeated excluded domain", { excludeDomains: ["a.io", "A.io"] }],
      ["a non-calendar day", { receivedFrom: "2026-02-30" }],
      ["a malformed day", { receivedTo: "2026-1-5" }],
      ["a timestamp for a day", { receivedFrom: "2026-01-01T00:00:00Z" }],
      [
        "a start after the end",
        { receivedFrom: "2026-03-02", receivedTo: "2026-03-01" },
      ],
      ["an unknown field", { userId: "x" }],
    ])("refuses %s", async (_n, filter) => {
      expect(
        (await check(CountEmailReceiptsDto, { filter })).errors,
      ).not.toHaveLength(0);
    });

    it("refuses a count without a filter", async () => {
      expect((await check(CountEmailReceiptsDto, {})).errors).not.toHaveLength(
        0,
      );
    });
  });

  describe("the reprocess body", () => {
    const run = (body: object) => check(BulkReprocessEmailReceiptsDto, body);
    it.each([
      { ids: [UUID_A] },
      { filter: {} },
      {
        filter: {},
        onlyStatuses: ["ignored"],
        limit: 25,
        since: "2026-10-01T00:00:00Z",
      },
      { ids: [UUID_A], limit: 1 },
    ])("accepts %j", async (body) => {
      expect((await run(body)).errors).toHaveLength(0);
    });

    it.each([
      ["neither ids nor filter", {}],
      ["both ids and filter", { ids: [UUID_A], filter: {} }],
      ["an empty ids list", { ids: [] }],
      [
        "501 ids",
        {
          ids: Array.from(
            { length: 501 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          ),
        },
      ],
      ["a limit of 0", { ids: [UUID_A], limit: 0 }],
      ["a limit of 26", { ids: [UUID_A], limit: 26 }],
      ["a fractional limit", { ids: [UUID_A], limit: 1.5 }],
      [
        "an unknown onlyStatuses member",
        { ids: [UUID_A], onlyStatuses: ["x"] },
      ],
      ["a bad since", { ids: [UUID_A], since: "yesterday" }],
      ["an unknown field", { ids: [UUID_A], expectedCount: 1 }],
    ])("refuses %s", async (_n, body) => {
      expect((await run(body)).errors).not.toHaveLength(0);
    });
  });

  describe("the approvable body", () => {
    const run = (body: object) => check(ApprovableEmailReceiptsDto, body);
    it("accepts ids or a filter", async () => {
      expect((await run({ ids: [UUID_A] })).errors).toHaveLength(0);
      expect((await run({ filter: { status: "review" } })).errors).toHaveLength(
        0,
      );
    });
    it.each([
      ["neither", {}],
      ["both", { ids: [UUID_A], filter: {} }],
      ["a limit", { ids: [UUID_A], limit: 5 }],
    ])("refuses %s", async (_n, body) => {
      expect((await run(body)).errors).not.toHaveLength(0);
    });
  });
});
