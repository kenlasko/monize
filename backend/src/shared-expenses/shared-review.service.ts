import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { getRequestContext } from "../common/request-context";
import { assertSharedPrincipal } from "./shared-db";
import { readSharedFinanceOverview } from "./shared-finance-overview";

export const SHARED_REVIEW_URL = "/shared-expenses/review";
export const SHARED_LEDGER_TOOLS = [
  "list_accounts",
  "list_transactions",
  "compare_periods",
  "get_budget_status",
  "generate_report",
] as const;

export interface SharedReviewGroup {
  groupId: string;
  accountId: string;
  accountName: string;
  pendingCount: number;
  accessRevoked: boolean;
}
export interface SharedReviewSummary {
  ledgerBasis: "ACCEPTED_SHARED_POSTINGS";
  pendingCount: number;
  unavailableGroupCount: number;
  groups: SharedReviewGroup[];
  reviewUrl: typeof SHARED_REVIEW_URL;
  checkedAt: string;
}

/** A leaf read service: no account writer, background posting or new identity seam. */
@Injectable()
export class SharedReviewService {
  private readonly logger = new Logger(SharedReviewService.name);
  constructor(private readonly dataSource: DataSource) {}

  summary(userId: string): Promise<SharedReviewSummary> {
    assertSharedPrincipal(userId);
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const integrations: Pick<
          SharedReviewGroup,
          "groupId" | "accountId" | "accountName"
        >[] = await manager.query(
          `SELECT i.group_id AS "groupId", i.account_id AS "accountId", a.name AS "accountName"
         FROM shared_integrations i JOIN accounts a ON a.id = i.account_id AND a.user_id = i.user_id
         WHERE i.user_id = $1 AND i.is_active ORDER BY a.name, i.group_id`,
          [userId],
        );
        const groups: SharedReviewGroup[] = [];
        for (const integration of integrations) {
          const overview = await readSharedFinanceOverview(
            manager,
            userId,
            integration.groupId,
          );
          groups.push({
            ...integration,
            pendingCount: overview.pendingCount,
            accessRevoked: overview.accessRevoked,
          });
        }
        return {
          ledgerBasis: "ACCEPTED_SHARED_POSTINGS",
          pendingCount: groups.reduce(
            (count, group) => count + group.pendingCount,
            0,
          ),
          unavailableGroupCount: groups.filter((group) => group.accessRevoked)
            .length,
          groups,
          reviewUrl: SHARED_REVIEW_URL,
          checkedAt: new Date().toISOString(),
        };
      },
      "REPEATABLE READ",
    );
  }

  /** Both model adapters receive this projection; failures never become a zero count. */
  async annotate(userId: string, data: unknown): Promise<unknown> {
    const context = getRequestContext();
    let sharedExpenses: Record<string, unknown>;
    if (context?.realUserId && context.realUserId !== userId) {
      sharedExpenses = {
        status: "OWNER_ONLY",
        pendingCount: null,
        unavailableGroupCount: null,
      };
    } else {
      try {
        const { groups, ...summary } = await this.summary(userId);
        if (groups.length === 0) return data;
        sharedExpenses = {
          ...summary,
          status:
            summary.pendingCount || summary.unavailableGroupCount
              ? "REVIEW_REQUIRED"
              : "CURRENT",
        };
      } catch {
        this.logger.warn("Could not read shared-expense review context");
        sharedExpenses = {
          status: "REQUEST_FAILED",
          pendingCount: null,
          unavailableGroupCount: null,
          reviewUrl: SHARED_REVIEW_URL,
        };
      }
    }
    return {
      ...(Array.isArray(data)
        ? { items: data }
        : data !== null && typeof data === "object"
          ? data
          : { value: data }),
      sharedExpenses: {
        ledgerBasis: "ACCEPTED_SHARED_POSTINGS",
        scope: "ALL_PERSONAL_INTEGRATIONS",
        guidance:
          "Financial figures include accepted personal bookings only. Shared changes awaiting review are not included. Do not add live group balances to these figures. Explain pending reviews or unavailable review status and link to reviewUrl.",
        ...sharedExpenses,
      },
    };
  }
}
