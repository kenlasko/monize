import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { randomUUID } from "crypto";
import { SharedEntryDto } from "./dto/shared-entry.dto";
import {
  SharedInvitationDto,
  UpdateSharedGroupDto,
} from "./dto/shared-group.dto";
import { UpdateSharedDocumentDto } from "./dto/shared-document.dto";

const options = { whitelist: true, forbidNonWhitelisted: true };
const validEntry = () => ({
  operationId: randomUUID(),
  expectedRevision: 0,
  type: "EXPENSE",
  title: "Dinner",
  amount: "300",
  currencyCode: "PLN",
  date: "2026-01-10",
  splitMode: "EQUAL",
  shares: [{ participantId: randomUUID() }],
  contributions: [{ participantId: randomUUID(), value: "300" }],
});
describe("Shared command admission", () => {
  it.each([undefined, "", "anna@example.test"])(
    "accepts the optional invitation email %j",
    async (email) => {
      expect(
        await validate(
          plainToInstance(SharedInvitationDto, {
            operationId: randomUUID(),
            expectedRevision: 0,
            participantId: randomUUID(),
            role: "EDITOR",
            email,
          }),
          options,
        ),
      ).toEqual([]);
    },
  );
  it("admits a normal entry without optional data", async () =>
    expect(
      await validate(plainToInstance(SharedEntryDto, validEntry()), options),
    ).toEqual([]));
  it.each([
    { amount: "NaN" },
    { amount: "1e3" },
    { amount: "1.00001" },
    { currencyCode: "bad-code" },
    { date: "2026-02-30" },
    { note: null },
    { fxRate: null },
    { expectedRevision: -1 },
    { shares: [{ participantId: randomUUID(), value: "-1" }] },
    { userId: randomUUID() },
    { title: "x".repeat(121) },
    {
      shares: Array.from({ length: 51 }, () => ({
        participantId: randomUUID(),
      })),
    },
  ])("rejects an invalid or injected entry field: %j", async (patch) => {
    expect(
      (
        await validate(
          plainToInstance(SharedEntryDto, { ...validEntry(), ...patch }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it("distinguishes clearing a saved template from an invalid exact-amount template", async () => {
    const command = { operationId: randomUUID(), expectedRevision: 1 };
    expect(
      await validate(
        plainToInstance(UpdateSharedGroupDto, {
          ...command,
          splitTemplate: null,
        }),
        options,
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateSharedGroupDto, {
            ...command,
            splitTemplate: { mode: "EXACT", shares: [] },
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it("accepts a group-file destination as explicit null and rejects arbitrary parent IDs", async () => {
    const input = {
      expectedRevision: 1,
      filename: "receipt.pdf",
      documentKind: "receipt",
    };
    expect(
      await validate(
        plainToInstance(UpdateSharedDocumentDto, { ...input, entryId: null }),
        options,
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateSharedDocumentDto, {
            ...input,
            entryId: "../../private",
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
