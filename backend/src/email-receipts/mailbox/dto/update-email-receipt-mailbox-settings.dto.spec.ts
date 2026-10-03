import { ValidationPipe } from "@nestjs/common";
import { UpdateEmailReceiptMailboxSettingsDto } from "./update-email-receipt-mailbox-settings.dto";

describe("UpdateEmailReceiptMailboxSettingsDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const check = (value: unknown) =>
    pipe.transform(value, {
      type: "body",
      metatype: UpdateEmailReceiptMailboxSettingsDto,
    }) as Promise<UpdateEmailReceiptMailboxSettingsDto>;

  it("accepts each field alone and all together", async () => {
    await expect(check({ folder: "  Receipts " })).resolves.toMatchObject({
      folder: "Receipts",
    });
    await expect(check({ enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
    await expect(check({ aiMode: "on_demand" })).resolves.toMatchObject({
      aiMode: "on_demand",
    });
    await expect(check({ autoApply: true })).resolves.toMatchObject({
      autoApply: true,
    });
    await expect(
      check({
        folder: "A",
        enabled: true,
        aiMode: "automatic",
        autoApply: false,
      }),
    ).resolves.toEqual({
      folder: "A",
      enabled: true,
      aiMode: "automatic",
      autoApply: false,
    });
  });

  it("treats a blank folder as not sent, like the full save", async () => {
    await expect(check({ folder: "", enabled: true })).resolves.toMatchObject({
      enabled: true,
    });
  });

  it("rejects what the full save rejects", async () => {
    for (const body of [
      { folder: "x".repeat(256) },
      { folder: "a\u0000b" },
      { folder: 5 },
      { enabled: "yes" },
      { aiMode: "sometimes" },
      { autoApply: 1 },
      { host: "imap.example.com" },
      { password: "nope" },
      { userId: "someone-else" },
    ]) {
      await expect(check(body)).rejects.toThrow();
    }
  });
});
