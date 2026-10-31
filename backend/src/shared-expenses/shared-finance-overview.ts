import { NotFoundException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import type { SharedFinanceOverview } from "./shared-finance-types";
import { assertSharedPrincipal, requireSharedGroup } from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import { sharedIntegration, sharedPostings } from "./shared-finance-read";
import { sharedReviewState } from "./shared-review-state";

export async function readSharedFinanceOverview(
  manager: EntityManager,
  userId: string,
  groupId: string,
): Promise<SharedFinanceOverview> {
  assertSharedPrincipal(userId);
  const integration = await sharedIntegration(manager, userId, groupId);
  let accessRevoked = false;
  try {
    await requireSharedGroup(manager, userId, groupId);
  } catch (error) {
    if (!(error instanceof NotFoundException) || !integration) throw error;
    accessRevoked = true;
  }
  if (!integration)
    return {
      integration: null,
      entries: [],
      pendingCount: 0,
      accessRevoked: false,
    };
  const postings = await sharedPostings(manager, userId, groupId);
  if (accessRevoked)
    return {
      integration,
      accessRevoked: true,
      pendingCount: 0,
      entries: postings.map((posting) => ({
        entryId: posting.entryId,
        title: posting.snapshot.title ?? "",
        date: posting.snapshot.effect.date,
        type: posting.snapshot.effect.type,
        state: posting.snapshot.effect.state,
        revision: posting.acceptedRevision,
        effect: posting.snapshot.effect,
        posting,
        needsReview: false,
        reviewReason: null,
      })),
    };
  const journal = await readSharedJournal(manager, groupId);
  const entries = journal.map((entry) => {
    const posting = postings.find((p) => p.entryId === entry.id) ?? null;
    const { effect, needsReview, reviewReason } = sharedReviewState(
      entry,
      integration.participantId,
      posting,
    );
    return {
      entryId: entry.id,
      title: entry.title,
      date: entry.date,
      type: entry.type,
      state: entry.state,
      revision: entry.revision,
      effect,
      posting,
      needsReview,
      reviewReason,
    };
  });
  return {
    integration,
    accessRevoked: false,
    entries,
    pendingCount: entries.filter((e) => e.needsReview).length,
  };
}
