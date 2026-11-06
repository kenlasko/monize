import {
  buildRuleFacts,
  deriveRuleType,
  loadAttachmentPresence,
  loadCategoryChains,
} from "./rule-facts";
import {
  reachedTransactionIdSql,
  reachingWarrantyJoinSql,
} from "../attachments/attachment-parent";
import { Warranty } from "../warranties/entities/warranty.entity";

const base = {
  accountId: "acc-1",
  currencyCode: "PLN",
  amount: -12.5,
  isTransfer: false,
  payeeId: null,
  payeeText: null,
  categoryId: null,
  description: null,
  tagIds: [] as string[],
  hasSplits: false,
};

describe("deriveRuleType", () => {
  it("is TRANSFER for a transfer leg whatever the sign", () => {
    expect(deriveRuleType(true, -100)).toBe("TRANSFER");
    expect(deriveRuleType(true, 100)).toBe("TRANSFER");
    expect(deriveRuleType(true, 0)).toBe("TRANSFER");
  });

  it("is INCOME above zero and EXPENSE below zero", () => {
    expect(deriveRuleType(false, 1)).toBe("INCOME");
    expect(deriveRuleType(false, -1)).toBe("EXPENSE");
  });

  it("is unknown (null) for a zero or missing amount, never a default type", () => {
    expect(deriveRuleType(false, 0)).toBeNull();
    expect(deriveRuleType(false, null)).toBeNull();
  });
});

describe("buildRuleFacts", () => {
  it("rounds the amount to a decimal at the storage scale, eight places", () => {
    expect(buildRuleFacts(base).amount).toBe(-12.5);
    expect(buildRuleFacts({ ...base, amount: "12.34567" }).amount).toBe(
      12.34567,
    );
    expect(buildRuleFacts({ ...base, amount: 0.1 + 0.2 }).amount).toBe(0.3);
    expect(buildRuleFacts({ ...base, amount: "-0.00002500" }).amount).toBe(
      -0.000025,
    );
  });

  it("carries the account, its currency, the payee id and the raw payee text", () => {
    const facts = buildRuleFacts({
      ...base,
      payeeId: "p-1",
      payeeText: "BIEDRONKA 123",
      description: "milk",
    });
    expect(facts).toEqual(
      expect.objectContaining({
        accountId: "acc-1",
        currencyCode: "PLN",
        payeeId: "p-1",
        payeeText: "BIEDRONKA 123",
        description: "milk",
        type: "EXPENSE",
        hasSplits: false,
      }),
    );
  });

  it("has no memo: the Transaction entity has no memo column", () => {
    expect(buildRuleFacts(base)).not.toHaveProperty("memo");
  });

  it("gives the category plus its ancestors, or an empty list without a category", () => {
    expect(buildRuleFacts(base).categoryAncestorIds).toEqual([]);
    expect(
      buildRuleFacts({
        ...base,
        categoryId: "c-child",
        categoryAncestorIds: ["c-child", "c-root"],
      }).categoryAncestorIds,
    ).toEqual(["c-child", "c-root"]);
    expect(
      buildRuleFacts({ ...base, categoryId: "c-1" }).categoryAncestorIds,
    ).toEqual(["c-1"]);
  });

  it("sets from/to accounts only on a transfer leg", () => {
    const plain = buildRuleFacts({
      ...base,
      fromAccountId: "a",
      toAccountId: "b",
    });
    expect(plain.fromAccountId).toBeNull();
    expect(plain.toAccountId).toBeNull();
    const leg = buildRuleFacts({
      ...base,
      isTransfer: true,
      fromAccountId: "a",
      toAccountId: "b",
    });
    expect([leg.type, leg.fromAccountId, leg.toAccountId]).toEqual([
      "TRANSFER",
      "a",
      "b",
    ]);
  });

  it("dedupes the tag ids and freezes the result", () => {
    const facts = buildRuleFacts({ ...base, tagIds: ["t1", "t1", "t2"] });
    expect(facts.tagIds).toEqual(["t1", "t2"]);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.tagIds)).toBe(true);
    expect(Object.isFrozen(facts.categoryAncestorIds)).toBe(true);
  });

  it("does not alias the caller's tag list", () => {
    const tags = ["t1"];
    const facts = buildRuleFacts({ ...base, tagIds: tags });
    tags.push("t2");
    expect(facts.tagIds).toEqual(["t1"]);
  });
});

describe("loadCategoryChains", () => {
  const rows = [
    { id: "root", parentId: null },
    { id: "mid", parentId: "root" },
    { id: "leaf", parentId: "mid" },
    { id: "loop-a", parentId: "loop-b" },
    { id: "loop-b", parentId: "loop-a" },
  ];
  const manager = (found = rows) => {
    const find = jest.fn().mockResolvedValue(found);
    return {
      find,
      m: { getRepository: jest.fn().mockReturnValue({ find }) } as never,
    };
  };

  it("walks parent ids in memory with one query, nearest first", async () => {
    const { find, m } = manager();
    const chains = await loadCategoryChains(m, "u1", ["leaf", "mid", "leaf"]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1" } }),
    );
    expect(chains.get("leaf")).toEqual(["leaf", "mid", "root"]);
    expect(chains.get("mid")).toEqual(["mid", "root"]);
  });

  it("maps an unknown id to itself and stops on a parent cycle", async () => {
    const { m } = manager();
    const chains = await loadCategoryChains(m, "u1", ["ghost", "loop-a"]);
    expect(chains.get("ghost")).toEqual(["ghost"]);
    expect(chains.get("loop-a")).toEqual(["loop-a", "loop-b"]);
  });

  it("issues no query for no ids", async () => {
    const { find, m } = manager();
    expect((await loadCategoryChains(m, "u1", [])).size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("loadAttachmentPresence", () => {
  const builder = (rows: Array<{ transactionId: string }>) => {
    const qb: Record<string, jest.Mock> = {};
    for (const name of [
      "leftJoin",
      "select",
      "distinct",
      "where",
      "andWhere",
    ] as const) {
      qb[name] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  // A document of a warranty linked to the row is one of the row's
  // attachments (the maintainer's ruling, attachment-parent.ts), so the read
  // keys each attachment by the transaction it is reached from, own or
  // through its warranty, with the shared fragments.
  it("asks once for the ids, the owner and visible attachments only (a scan pair counts once)", async () => {
    const qb = builder([{ transactionId: "t1" }]);
    const m = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      }),
    };
    const found = await loadAttachmentPresence(m as never, "u1", [
      "t1",
      "t2",
      "t1",
    ]);
    expect([...found]).toEqual(["t1"]);
    expect(m.getRepository).toHaveBeenCalledTimes(1);
    expect(qb.where).toHaveBeenCalledWith("ta.userId = :userId", {
      userId: "u1",
    });
    const reachedFrom = reachedTransactionIdSql("ta", "w");
    expect(qb.leftJoin).toHaveBeenCalledWith(
      Warranty,
      "w",
      reachingWarrantyJoinSql("ta", "w"),
    );
    expect(qb.select).toHaveBeenCalledWith(reachedFrom, "transactionId");
    expect(qb.andWhere).toHaveBeenCalledWith(`${reachedFrom} IN (:...wanted)`, {
      wanted: ["t1", "t2"],
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      "ta.original_of_attachment_id IS NULL",
    );
    expect(qb.distinct).toHaveBeenCalledWith(true);
  });

  it("does not query for no ids", async () => {
    const m = { getRepository: jest.fn() };
    expect((await loadAttachmentPresence(m as never, "u1", [])).size).toBe(0);
    expect(m.getRepository).not.toHaveBeenCalled();
  });
});
