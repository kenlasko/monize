import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { readSharedFinanceOverview } from "./shared-finance-overview";
import { requireSharedGroup } from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import { sharedIntegration, sharedPostings } from "./shared-finance-read";
import { sharedGroupFixture } from "./__fixtures__/shared-group";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import {
  sharedPostingFixture,
  sharedIntegrationFixture,
} from "./__fixtures__/shared-finance";

jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
jest.mock("./shared-finance-read", () => ({
  sharedIntegration: jest.fn(),
  sharedPostings: jest.fn(),
}));

describe("Private finance overview after group access changes", () => {
  const manager = {} as EntityManager;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    jest
      .mocked(sharedIntegration)
      .mockResolvedValue(sharedIntegrationFixture());
    jest.mocked(sharedPostings).mockResolvedValue([]);
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
  });
  it("returns known empty integration without reading the journal or postings", async () => {
    jest.mocked(sharedIntegration).mockResolvedValue(null);
    expect(await readSharedFinanceOverview(manager, "owner", "group")).toEqual({
      integration: null,
      entries: [],
      pendingCount: 0,
      accessRevoked: false,
    });
    expect(readSharedJournal).not.toHaveBeenCalled();
    expect(sharedPostings).not.toHaveBeenCalled();
  });
  it("keeps accepted snapshots readable after revocation without fetching live journal data", async () => {
    jest.mocked(requireSharedGroup).mockRejectedValue(new NotFoundException());
    jest.mocked(sharedPostings).mockResolvedValue([sharedPostingFixture()]);
    const result = await readSharedFinanceOverview(manager, "owner", "group");
    expect(result).toMatchObject({
      accessRevoked: true,
      pendingCount: 0,
      entries: [{ needsReview: false, reviewReason: null }],
    });
    expect(readSharedJournal).not.toHaveBeenCalled();
  });
  it("does not invent a retained snapshot for a stranger", async () => {
    jest.mocked(sharedIntegration).mockResolvedValue(null);
    jest.mocked(requireSharedGroup).mockRejectedValue(new NotFoundException());
    await expect(
      readSharedFinanceOverview(manager, "owner", "group"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sharedPostings).not.toHaveBeenCalled();
  });
  it("does not misreport a permission or request failure as revoked membership", async () => {
    jest.mocked(requireSharedGroup).mockRejectedValue(new ForbiddenException());
    await expect(
      readSharedFinanceOverview(manager, "owner", "group"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("offers unbooked entries without requiring the participant to add them", async () => {
    const result = await readSharedFinanceOverview(manager, "owner", "group");
    expect(result).toMatchObject({
      pendingCount: 0,
      accessRevoked: false,
      entries: [
        { entryId: "entry", reviewReason: "NOT_BOOKED", needsReview: false },
      ],
    });
  });
});
