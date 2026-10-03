import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  TestEmailReceiptMailboxDto,
  UpsertEmailReceiptMailboxDto,
} from "./upsert-email-receipt-mailbox.dto";

const valid = {
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "receipts@example.com",
  password: "app-password",
  enabled: true,
  aiMode: "off",
  autoApply: false,
};

function upsert(over: Record<string, unknown> = {}) {
  return plainToInstance(
    UpsertEmailReceiptMailboxDto,
    { ...valid, ...over },
    { enableImplicitConversion: true },
  );
}

async function errorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
}

describe("UpsertEmailReceiptMailboxDto", () => {
  it("accepts a complete request", async () => {
    expect(await errorsOf(upsert())).toEqual([]);
  });

  it("accepts a request with no password or folder (keep and default)", async () => {
    const { password: _password, ...withoutPassword } = valid;
    const dto = plainToInstance(UpsertEmailReceiptMailboxDto, withoutPassword);
    expect(await errorsOf(dto)).toEqual([]);
    expect(dto.folder).toBeUndefined();
  });

  it("accepts a blank password and folder, which a form resends for 'keep'", async () => {
    expect(await errorsOf(upsert({ password: "", folder: "" }))).toEqual([]);
  });

  it("trims and lower-cases the host and strips angle brackets", () => {
    expect(upsert({ host: "  IMAP.Example.COM " }).host).toBe(
      "imap.example.com",
    );
    expect(upsert({ host: "<b>Mail</b>.example.com" }).host).toBe(
      "bmail/b.example.com",
    );
  });

  it.each([
    "mail.example.com/path",
    "user@mail.example.com",
    "https://mail.example.com",
    "mail example.com",
    "mail.example.com:993",
    "-bad.example.com",
    "",
  ])("rejects the host %j", async (host) => {
    expect(await errorsOf(upsert({ host }))).toContain("host");
  });

  it.each(["[::1]", "::1", "2001:db8::1", "10.0.0.1", "mail-1.example.com"])(
    "accepts the host %s as a shape (the policy decides the rest)",
    async (host) => {
      expect(await errorsOf(upsert({ host }))).toEqual([]);
    },
  );

  it.each([0, 65536, -1, 1.5])("rejects the port %s", async (port) => {
    expect(await errorsOf(upsert({ port }))).toContain("port");
  });

  it.each(["none", "plain", "TLS", "", undefined])(
    "rejects the security %j, so there is no plaintext mode",
    async (security) => {
      expect(await errorsOf(upsert({ security }))).toContain("security");
    },
  );

  it("bounds the user name, the password and the folder", async () => {
    expect(await errorsOf(upsert({ username: "u".repeat(321) }))).toEqual([
      "username",
    ]);
    expect(await errorsOf(upsert({ password: "p".repeat(1001) }))).toEqual([
      "password",
    ]);
    expect(await errorsOf(upsert({ folder: "f".repeat(256) }))).toEqual([
      "folder",
    ]);
  });

  it("rejects a control character in the password, the user name and the folder", async () => {
    expect(await errorsOf(upsert({ password: "pass\nword" }))).toEqual([
      "password",
    ]);
    expect(await errorsOf(upsert({ username: "user\u0000" }))).toEqual([
      "username",
    ]);
    expect(await errorsOf(upsert({ folder: "IN\rBOX" }))).toEqual(["folder"]);
  });

  it("keeps a password's surrounding spaces, since they may be part of it", () => {
    expect(upsert({ password: " spaced " }).password).toBe(" spaced ");
  });

  it("requires the switches and the mode", async () => {
    const dto = plainToInstance(UpsertEmailReceiptMailboxDto, {
      host: valid.host,
      port: valid.port,
      security: valid.security,
      username: valid.username,
    });
    expect(await errorsOf(dto)).toEqual(["aiMode", "autoApply", "enabled"]);
    expect(await errorsOf(upsert({ aiMode: "always" }))).toEqual(["aiMode"]);
  });

  it("refuses a field it does not declare", async () => {
    expect(await errorsOf(upsert({ userId: "someone-else" }))).toEqual([
      "userId",
    ]);
  });
});

describe("TestEmailReceiptMailboxDto", () => {
  it("accepts an empty draft, which tests the stored settings", async () => {
    expect(
      await errorsOf(plainToInstance(TestEmailReceiptMailboxDto, {})),
    ).toEqual([]);
  });

  it("holds a draft field to the same rules", async () => {
    const dto = plainToInstance(TestEmailReceiptMailboxDto, {
      host: "a/b",
      port: 0,
      security: "none",
    });
    expect(await errorsOf(dto)).toEqual(["host", "port", "security"]);
  });

  it("does not accept the switches, which a test does not change", async () => {
    const dto = plainToInstance(TestEmailReceiptMailboxDto, {
      enabled: true,
    });
    expect(await errorsOf(dto)).toEqual(["enabled"]);
  });
});
