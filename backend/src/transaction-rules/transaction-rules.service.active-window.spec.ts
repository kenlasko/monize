import { BadRequestException } from "@nestjs/common";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import {
  RULE_ID,
  USER_ID,
  VALID_ACTIONS,
  VALID_CONDITION,
  buildHarness,
  storedRule,
  thrown,
} from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/** INV-RULE-004: the active window is stored, ordered and compared on update. */
const createDto = (over: Partial<CreateTransactionRuleDto> = {}) =>
  ({
    name: "Mortgage",
    triggers: ["create", "import"],
    condition: VALID_CONDITION,
    actions: VALID_ACTIONS,
    ...over,
  }) as unknown as CreateTransactionRuleDto;

const updateDto = (over: Partial<UpdateTransactionRuleDto> = {}) =>
  ({ revision: 3, ...over }) as UpdateTransactionRuleDto;

const refusedWindow = (error: BadRequestException) =>
  expect(error.getResponse()).toEqual(
    expect.objectContaining({ errorCode: "ACTIVE_WINDOW_INVALID" }),
  );

describe("TransactionRulesService create: the active window", () => {
  it("stores both sides and returns them", async () => {
    const h = buildHarness();
    const result = await h.service.create(
      USER_ID,
      createDto({ activeFrom: "2026-10-01", activeTo: "2026-12-31" }),
    );
    expect(h.rules.create).toHaveBeenCalledWith(
      expect.objectContaining({
        activeFrom: "2026-10-01",
        activeTo: "2026-12-31",
      }),
    );
    expect(result).toMatchObject({
      activeFrom: "2026-10-01",
      activeTo: "2026-12-31",
    });
  });

  it("stores an absent or blank side as null", async () => {
    const h = buildHarness();
    const result = await h.service.create(
      USER_ID,
      createDto({ activeFrom: "", activeTo: undefined }),
    );
    expect(h.rules.create).toHaveBeenCalledWith(
      expect.objectContaining({ activeFrom: null, activeTo: null }),
    );
    expect(result).toMatchObject({ activeFrom: null, activeTo: null });
  });

  it("accepts a one-day window", async () => {
    const h = buildHarness();
    await h.service.create(
      USER_ID,
      createDto({ activeFrom: "2026-10-01", activeTo: "2026-10-01" }),
    );
    expect(h.rules.save).toHaveBeenCalledTimes(1);
  });

  it("refuses a window whose first day is after its last, and writes nothing", async () => {
    const h = buildHarness();
    const error = await thrown(
      h.service.create(
        USER_ID,
        createDto({ activeFrom: "2026-12-31", activeTo: "2026-10-01" }),
      ),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    refusedWindow(error);
    expect(h.writes()).toEqual([]);
  });
});

describe("TransactionRulesService update: the active window", () => {
  it("writes a changed side in the same swap that bumps the revision", async () => {
    const h = buildHarness();
    h.rules.findOne
      .mockResolvedValueOnce(storedRule())
      .mockResolvedValueOnce(
        storedRule({ activeFrom: "2026-10-01", revision: 4 }),
      );
    const result = await h.service.update(
      USER_ID,
      RULE_ID,
      updateDto({ activeFrom: "2026-10-01" }),
    );
    expect(h.rules.update).toHaveBeenCalledWith(
      { id: RULE_ID, userId: USER_ID, revision: 3 },
      { activeFrom: "2026-10-01", revision: expect.any(Function) },
    );
    expect(result).toMatchObject({ activeFrom: "2026-10-01", revision: 4 });
  });

  it("clears a side with null or a blank string", async () => {
    for (const cleared of [null, ""]) {
      const h = buildHarness();
      h.rules.findOne
        .mockResolvedValueOnce(
          storedRule({ activeFrom: "2026-10-01", activeTo: "2026-12-31" }),
        )
        .mockResolvedValueOnce(
          storedRule({ activeFrom: "2026-10-01", activeTo: null }),
        );
      await h.service.update(
        USER_ID,
        RULE_ID,
        updateDto({ activeTo: cleared }),
      );
      expect(h.rules.update.mock.calls[0][1]).toEqual({
        activeTo: null,
        revision: expect.any(Function),
      });
    }
  });

  it("is no edit when the resent window equals the stored one", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(
      storedRule({ activeFrom: "2026-10-01", activeTo: null }),
    );
    await h.service.update(
      USER_ID,
      RULE_ID,
      updateDto({ activeFrom: "2026-10-01", activeTo: null }),
    );
    expect(h.writes()).toEqual([]);
  });

  it("leaves a side alone when the request omits it", async () => {
    const h = buildHarness();
    h.rules.findOne
      .mockResolvedValueOnce(storedRule({ activeFrom: "2026-10-01" }))
      .mockResolvedValueOnce(storedRule({ activeFrom: "2026-10-01" }));
    await h.service.update(USER_ID, RULE_ID, updateDto({ name: "Renamed" }));
    expect(h.rules.update.mock.calls[0][1]).toEqual({
      name: "Renamed",
      revision: expect.any(Function),
    });
  });

  it("refuses a first day after the last, and writes nothing", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule());
    const error = await thrown(
      h.service.update(
        USER_ID,
        RULE_ID,
        updateDto({ activeFrom: "2026-12-31", activeTo: "2026-10-01" }),
      ),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    refusedWindow(error);
    expect(h.writes()).toEqual([]);
  });

  it("checks one moved side against the stored other side", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ activeTo: "2026-10-01" }));
    const error = await thrown(
      h.service.update(
        USER_ID,
        RULE_ID,
        updateDto({ activeFrom: "2026-11-01" }),
      ),
    );
    refusedWindow(error);
    expect(h.writes()).toEqual([]);

    const later = buildHarness();
    later.rules.findOne.mockResolvedValue(
      storedRule({ activeFrom: "2026-10-01" }),
    );
    const again = await thrown(
      later.service.update(
        USER_ID,
        RULE_ID,
        updateDto({ activeTo: "2026-09-30" }),
      ),
    );
    refusedWindow(again);
    expect(later.writes()).toEqual([]);
  });

  it("lets a request that moves the first day past the stored last day also clear the last", async () => {
    const h = buildHarness();
    h.rules.findOne
      .mockResolvedValueOnce(storedRule({ activeTo: "2026-10-01" }))
      .mockResolvedValueOnce(storedRule({ activeFrom: "2026-11-01" }));
    await h.service.update(
      USER_ID,
      RULE_ID,
      updateDto({ activeFrom: "2026-11-01", activeTo: null }),
    );
    expect(h.rules.update).toHaveBeenCalledTimes(1);
  });
});
