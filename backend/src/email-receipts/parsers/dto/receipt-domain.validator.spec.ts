import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreateEmailReceiptParserDto,
  UpdateEmailReceiptParserDto,
} from "./email-receipt-parser.dto";
import {
  isReceiptDomain,
  normalizeReceiptDomain,
} from "./receipt-domain.validator";

describe("receipt domains", () => {
  it("normalizes: trimmed, lower-case, no leading @, no trailing dot", () => {
    expect(normalizeReceiptDomain("  @@Shop.Example.COM. ")).toBe(
      "shop.example.com",
    );
    expect(normalizeReceiptDomain(42)).toBe(42);
  });

  it.each(["shop.example.com", "a.co", "x-y.example.org", "1.example.com"])(
    "accepts %s",
    (value) => expect(isReceiptDomain(value)).toBe(true),
  );

  it.each([
    "",
    "localhost",
    "shop",
    "-a.example.com",
    "a-.example.com",
    "a..example.com",
    "shop.example.com/path",
    "user@shop.example.com",
    "shop.example.com:993",
    "shop example.com",
    "a".repeat(64) + ".example.com",
    `${"a.".repeat(130)}com`,
    42,
    null,
  ])("rejects %p", (value) => expect(isReceiptDomain(value)).toBe(false));
});

describe("CreateEmailReceiptParserDto", () => {
  const base = {
    name: "Shop",
    fromDomains: ["@Shop.Example.com"],
    definition: { version: 1 },
  };
  const check = async (over: Record<string, unknown> = {}) => {
    const dto = plainToInstance(CreateEmailReceiptParserDto, {
      ...base,
      ...over,
    });
    return { dto, errors: await validate(dto) };
  };

  it("accepts a minimal parser and normalizes the domains", async () => {
    const { dto, errors } = await check();
    expect(errors).toEqual([]);
    expect(dto.fromDomains).toEqual(["shop.example.com"]);
  });

  it("bounds the name, the domains and the subject words", async () => {
    expect((await check({ name: "x".repeat(101) })).errors).not.toEqual([]);
    expect((await check({ name: "   " })).errors).not.toEqual([]);
    expect((await check({ fromDomains: [] })).errors).not.toEqual([]);
    expect(
      (await check({ fromDomains: Array(11).fill("a.example.com") })).errors,
    ).not.toEqual([]);
    expect((await check({ fromDomains: ["nodot"] })).errors).not.toEqual([]);
    expect(
      (await check({ subjectContains: Array(11).fill("word") })).errors,
    ).not.toEqual([]);
    expect(
      (await check({ subjectContains: ["x".repeat(101)] })).errors,
    ).not.toEqual([]);
    expect((await check({ subjectContains: [""] })).errors).not.toEqual([]);
  });

  it("lower-cases subject words", async () => {
    const { dto, errors } = await check({ subjectContains: [" Order "] });
    expect(errors).toEqual([]);
    expect(dto.subjectContains).toEqual(["order"]);
  });

  it("takes a blank or null payee as none, and refuses a non-UUID", async () => {
    expect((await check({ payeeId: null })).errors).toEqual([]);
    expect((await check({ payeeId: "" })).errors).toEqual([]);
    expect((await check({ payeeId: "nope" })).errors).not.toEqual([]);
  });

  it("requires the definition to be an object", async () => {
    expect((await check({ definition: "x" })).errors).not.toEqual([]);
    expect((await check({ definition: [] })).errors).not.toEqual([]);
  });

  it("update demands the revision and keeps every other field optional", async () => {
    const ok = plainToInstance(UpdateEmailReceiptParserDto, {
      expectedRevision: 2,
    });
    expect(await validate(ok)).toEqual([]);
    const missing = plainToInstance(UpdateEmailReceiptParserDto, {
      name: "x",
    });
    expect(await validate(missing)).not.toEqual([]);
  });
});
