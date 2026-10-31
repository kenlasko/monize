import { ForbiddenException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { requestContextStorage } from "../common/request-context";
import { readSharedFinanceOverview } from "./shared-finance-overview";
import {
  SharedReviewService,
  SharedReviewSummary,
} from "./shared-review.service";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-finance-overview", () => ({
  readSharedFinanceOverview: jest.fn(),
}));

describe("Report and model shared-review disclosure", () => {
  let service: SharedReviewService;
  let query: jest.Mock;
  const base = (): SharedReviewSummary => ({
    ledgerBasis: "ACCEPTED_SHARED_POSTINGS",
    pendingCount: 0,
    unavailableGroupCount: 0,
    groups: [],
    reviewUrl: "/shared-expenses/review",
    checkedAt: "2026-10-26T12:00:00Z",
  });
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    jest
      .mocked(withScopedDb)
      .mockImplementation((_source, work) =>
        work({ query } as unknown as EntityManager),
      );
    service = new SharedReviewService({} as DataSource);
  });
  it("counts pending entries and separately names inaccessible groups in one snapshot", async () => {
    query.mockResolvedValue([
      { groupId: "group", accountId: "account", accountName: "Trip" },
      { groupId: "revoked", accountId: "kept", accountName: "Retained" },
    ]);
    jest
      .mocked(readSharedFinanceOverview)
      .mockResolvedValueOnce({
        integration: null,
        entries: [],
        accessRevoked: false,
        pendingCount: 3,
      })
      .mockResolvedValueOnce({
        integration: null,
        entries: [],
        accessRevoked: true,
        pendingCount: 0,
      });
    expect(await service.summary("owner")).toMatchObject({
      pendingCount: 3,
      unavailableGroupCount: 1,
      groups: [
        { accountName: "Trip", pendingCount: 3 },
        { accountName: "Retained", accessRevoked: true },
      ],
    });
    expect(withScopedDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "REPEATABLE READ",
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("i.user_id = $1 AND i.is_active"),
      ["owner"],
    );
    expect(readSharedFinanceOverview).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "owner",
      "revoked",
    );
  });
  it("has no pending cost when no personal integration exists", async () => {
    expect(await service.summary("owner")).toMatchObject({
      pendingCount: 0,
      unavailableGroupCount: 0,
      groups: [],
    });
    expect(readSharedFinanceOverview).not.toHaveBeenCalled();
  });
  it("does not read an owner's private groups under a delegate identity", async () => {
    await requestContextStorage.run(
      { userId: "owner", realUserId: "delegate" },
      async () => {
        expect(() => service.summary("owner")).toThrow(ForbiddenException);
        expect(await service.annotate("owner", { total: 20 })).toMatchObject({
          total: 20,
          sharedExpenses: { status: "OWNER_ONLY", pendingCount: null },
        });
      },
    );
    expect(withScopedDb).not.toHaveBeenCalled();
  });
  it("keeps accepted numbers and dates; exposes the same review count without private group names to models", async () => {
    jest.spyOn(service, "summary").mockResolvedValue({
      ...base(),
      pendingCount: 2,
      groups: [
        {
          groupId: "private",
          accountId: "private-account",
          accountName: "Private name",
          pendingCount: 2,
          accessRevoked: false,
        },
      ],
    });
    const data = { total: 100, date: "2026-01-01" };
    const result = await service.annotate("owner", data);
    expect(result).toMatchObject({
      ...data,
      sharedExpenses: {
        pendingCount: 2,
        status: "REVIEW_REQUIRED",
        reviewUrl: "/shared-expenses/review",
        scope: "ALL_PERSONAL_INTEGRATIONS",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Private name");
    expect(data).toEqual({ total: 100, date: "2026-01-01" });
  });
  it("keeps the no-integration shape and wraps an array only when disclosure is needed", async () => {
    const spy = jest.spyOn(service, "summary").mockResolvedValue(base());
    const rows = [{ amount: 40 }];
    expect(await service.annotate("owner", rows)).toBe(rows);
    spy.mockResolvedValue({
      ...base(),
      groups: [
        {
          groupId: "g",
          accountId: "a",
          accountName: "Trip",
          pendingCount: 0,
          accessRevoked: false,
        },
      ],
    });
    expect(await service.annotate("owner", rows)).toMatchObject({
      items: rows,
      sharedExpenses: { pendingCount: 0, status: "CURRENT" },
    });
  });
  it("marks a failed lookup as unknown without changing the accepted financial result", async () => {
    jest
      .spyOn(service, "summary")
      .mockRejectedValue(new Error("database unavailable"));
    expect(await service.annotate("owner", { total: 100 })).toMatchObject({
      total: 100,
      sharedExpenses: {
        status: "REQUEST_FAILED",
        pendingCount: null,
        unavailableGroupCount: null,
      },
    });
  });
});
