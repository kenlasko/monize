import {
  carryRecordedReceivedAmounts,
  ownSplitCounterpartsOnly,
  RecordedTransferLine,
} from "./split-received-amount.util";

describe("carryRecordedReceivedAmounts", () => {
  const recorded: RecordedTransferLine[] = [
    {
      transferAccountId: "usd",
      amount: "-40.0000",
      counterpartAmount: "28.7500",
      counterpartCurrencyCode: "USD",
    },
    {
      transferAccountId: "cad-sav",
      amount: "-10.0000",
      counterpartAmount: "10.0000",
      counterpartCurrencyCode: "CAD",
    },
    {
      transferAccountId: null,
      amount: "-50.0000",
      counterpartAmount: null,
      counterpartCurrencyCode: null,
    },
  ];
  const context = { sourceCurrencyCode: "CAD", parentAccountUnchanged: true };

  it("keeps what a continuing cross-currency line received", () => {
    const [line] = carryRecordedReceivedAmounts(
      recorded,
      [{ transferAccountId: "usd", amount: -40, memo: "renamed" }],
      context,
    );
    expect(line.transferTargetAmount).toBe(28.75);
    expect(line.memo).toBe("renamed");
  });

  it("re-converts a line whose amount or target changed", () => {
    const lines = carryRecordedReceivedAmounts(
      recorded,
      [
        { transferAccountId: "usd", amount: -45 },
        { transferAccountId: "eur", amount: -40 },
      ],
      context,
    );
    expect(lines.map((l) => l.transferTargetAmount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("never overrides a received amount the caller states", () => {
    const [line] = carryRecordedReceivedAmounts(
      recorded,
      [{ transferAccountId: "usd", amount: -40, transferTargetAmount: 29.2 }],
      context,
    );
    expect(line.transferTargetAmount).toBe(29.2);
  });

  it("claims each recorded line once", () => {
    const lines = carryRecordedReceivedAmounts(
      recorded,
      [
        { transferAccountId: "usd", amount: -40 },
        { transferAccountId: "usd", amount: -40 },
      ],
      context,
    );
    expect(lines.map((l) => l.transferTargetAmount)).toEqual([
      28.75,
      undefined,
    ]);
  });

  it("carries nothing from a same-currency line or once the parent account moves", () => {
    expect(
      carryRecordedReceivedAmounts(
        recorded,
        [{ transferAccountId: "cad-sav", amount: -10 }],
        context,
      )[0].transferTargetAmount,
    ).toBeUndefined();
    expect(
      carryRecordedReceivedAmounts(
        recorded,
        [{ transferAccountId: "usd", amount: -40 }],
        { ...context, parentAccountUnchanged: false },
      )[0].transferTargetAmount,
    ).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const incoming = [{ transferAccountId: "usd", amount: -40 }];
    carryRecordedReceivedAmounts(recorded, incoming, context);
    expect(incoming[0]).toEqual({ transferAccountId: "usd", amount: -40 });
  });
});

describe("ownSplitCounterpartsOnly", () => {
  const row = (userId: string) => ({
    userId,
    splits: [{ id: "s1", linkedTransaction: { id: "t2", amount: 28.75 } }],
  });

  it("keeps the counterpart on the reader's own rows", () => {
    const [own] = ownSplitCounterpartsOnly("me", [row("me")]);
    expect(own.splits[0].linkedTransaction).toEqual({
      id: "t2",
      amount: 28.75,
    });
  });

  it("drops it from another owner's row a joint reader sees", () => {
    const [other] = ownSplitCounterpartsOnly("me", [row("owner")]);
    expect(other.splits[0].linkedTransaction).toBeNull();
    expect(other.splits[0].id).toBe("s1");
  });
});
