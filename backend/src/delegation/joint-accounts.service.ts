import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { roundMoney } from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { todayYMD } from "../common/date-utils";
import { tr } from "../i18n/translate";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { User } from "../users/entities/user.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { DelegateNetWorthExclusion } from "./entities/delegate-net-worth-exclusion.entity";
import {
  AccountAccess,
  CrossOwnerAccessService,
} from "./cross-owner-access.service";
import { DelegateOperation } from "./decorators/delegate-access.decorator";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";

/**
 * The single definition of which account types a joint grantee may WRITE to
 * in v1 (joint-accounts spec, type truth table). Every other type is
 * shareable read-only: visible in lists, register and net worth, but the
 * grant's write flags are masked off. The effective permissions the client
 * receives are computed with this same set, so UI affordances and service
 * authorization can never disagree.
 */
export const JOINT_WRITABLE_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "CHEQUING",
  "SAVINGS",
  "CASH",
  "CREDIT_CARD",
  "LINE_OF_CREDIT",
]);

/** Effective write permissions for one grantee on one joint account. */
export interface JointPermissions {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** One active joint grant, from the grantee's perspective. */
export interface JointGrantInfo {
  delegationId: string;
  ownerUserId: string;
  ownerLabel: string;
  permissions: JointPermissions;
}

/**
 * An account shared jointly to the caller, enriched for the union account
 * list. `canDelete` is the account-object deletability flag the list already
 * carries -- always false for a joint row (the account object is owner-only).
 * `excludeFromNetWorth` carries the GRANTEE's overlay, not the owner's flag.
 */
export type JointAccountRow = Account & {
  isJoint: true;
  ownerLabel: string;
  jointPermissions: JointPermissions;
  canDelete: boolean;
  futureTransactionsSum: number;
};

/**
 * Native ("joint account") visibility on top of Shared Access grants: a grant
 * row with can_read AND is_joint under an active delegation makes the account
 * appear in the grantee's OWN context. This service is the authoritative
 * app-layer decision for every native joint read and write -- own-context
 * requests bypass the delegate guard entirely, so authorization cannot live
 * there (same argument as CrossOwnerAccessService, which this service builds
 * on).
 *
 * Lives beside DelegationService rather than inside it because that file is
 * at the line-count cap.
 */
@Injectable()
export class JointAccountsService {
  constructor(
    private dataSource: DataSource,
    private crossOwnerAccess: CrossOwnerAccessService,
  ) {}

  /**
   * Every active joint grant where `realUserId` is the delegate, keyed by
   * account id. Permissions are the grant flags -- the account-type policy is
   * applied later, where the account row (and so its type) is known.
   */
  async jointGrantsFor(
    realUserId: string,
  ): Promise<Map<string, JointGrantInfo>> {
    const delegations = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        select: ["id", "ownerUserId"],
      }),
    );
    if (delegations.length === 0) return new Map();

    const grants = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegateGrant).find({
        where: {
          delegationId: In(delegations.map((d) => d.id)),
          canRead: true,
          isJoint: true,
        },
      }),
    );
    if (grants.length === 0) return new Map();

    // Authorization-decision read: the owners' user rows are not visible to
    // the grantee's own session under enforcement (users_self policy), but
    // their display label legitimately is -- the acting UI already shows it.
    // Only the label leaves this method.
    const ownerIds = [...new Set(delegations.map((d) => d.ownerUserId))];
    const owners = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(User).find({
          where: { id: In(ownerIds) },
          select: ["id", "firstName", "lastName", "email"],
        }),
      ),
    );
    const labelByOwner = new Map(owners.map((u) => [u.id, this.userLabel(u)]));
    const delegationById = new Map(delegations.map((d) => [d.id, d]));

    const result = new Map<string, JointGrantInfo>();
    for (const grant of grants) {
      const delegation = delegationById.get(grant.delegationId);
      if (!delegation) continue;
      result.set(grant.accountId, {
        delegationId: grant.delegationId,
        ownerUserId: delegation.ownerUserId,
        ownerLabel:
          labelByOwner.get(delegation.ownerUserId) ?? delegation.ownerUserId,
        permissions: {
          canCreate: grant.canCreate,
          canEdit: grant.canEdit,
          canDelete: grant.canDelete,
        },
      });
    }
    return result;
  }

  /** The account ids jointly shared to `realUserId` (cheap, ids only). */
  async jointAccountIdSetFor(realUserId: string): Promise<Set<string>> {
    const delegations = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        select: ["id"],
      }),
    );
    if (delegations.length === 0) return new Set();

    const grants = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegateGrant).find({
        where: {
          delegationId: In(delegations.map((d) => d.id)),
          canRead: true,
          isJoint: true,
        },
        select: ["accountId"],
      }),
    );
    return new Set(grants.map((g) => g.accountId));
  }

  /**
   * The full joint rows for the grantee's union account list: the owner's
   * account rows enriched with `isJoint`, `ownerLabel`, effective
   * `jointPermissions` (grant flags AND the account-type policy), the
   * grantee's net-worth-exclusion overlay, and the same live currentBalance /
   * futureTransactionsSum the owned rows carry so the two halves of the list
   * agree on what a balance means.
   */
  async jointAccountsFor(realUserId: string): Promise<JointAccountRow[]> {
    const grants = await this.jointGrantsFor(realUserId);
    if (grants.size === 0) return [];

    const accountIds = [...grants.keys()];
    // The granted account rows are readable in the grantee's own session (the
    // migration-134 read arm under enforcement; no policies at off/shadow),
    // so no system-context window is needed here.
    const accounts = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).find({
        where: { id: In(accountIds) },
        order: { name: "ASC" },
      }),
    );

    const exclusions = await this.getNetWorthExclusions(realUserId);
    const today = todayYMD();

    const [futureSums, currentSums, places] = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const future: Array<{ accountId: string; futureSum: string }> =
          await manager.query(
            `SELECT t.account_id as "accountId",
                COALESCE(SUM(t.amount), 0) as "futureSum"
             FROM transactions t
             WHERE t.account_id = ANY($1)
               AND t.transaction_date > $2
               AND ${LEDGER_MOVEMENT_PREDICATE}
             GROUP BY t.account_id`,
            [accountIds, today],
          );
        const current: Array<{ accountId: string; currentBalance: string }> =
          await manager.query(
            `SELECT a.id as "accountId",
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as "currentBalance"
             FROM accounts a
             LEFT JOIN transactions t ON t.account_id = a.id
               AND ${LEDGER_MOVEMENT_PREDICATE}
               AND t.transaction_date <= $2
             WHERE a.id = ANY($1)
             GROUP BY a.id, a.opening_balance`,
            [accountIds, today],
          );
        // Each account's sums are in its own currency, rounded at its
        // precision; the currencies are read once for the whole list.
        const currencyPlaces = await loadCurrencyPlacesForRead(
          manager,
          accounts.map((a) => a.currencyCode),
        );
        return [future, current, currencyPlaces] as const;
      },
    );
    const decimalsOf = new Map(
      accounts.map((a) => [a.id, moneyDecimalsForCode(places, a.currencyCode)]),
    );
    const futureSumMap = new Map(
      futureSums.map((r) => [
        r.accountId,
        roundMoney(Number(r.futureSum), decimalsOf.get(r.accountId)),
      ]),
    );
    const currentBalanceMap = new Map(
      currentSums.map((r) => [
        r.accountId,
        roundMoney(Number(r.currentBalance), decimalsOf.get(r.accountId)),
      ]),
    );

    return accounts.map((account) => {
      const grant = grants.get(account.id)!;
      return {
        ...account,
        currentBalance:
          currentBalanceMap.get(account.id) ?? account.currentBalance,
        isJoint: true as const,
        ownerLabel: grant.ownerLabel,
        jointPermissions: this.effectivePermissions(account, grant.permissions),
        // The grantee's overlay, not the owner's flag: net-worth inclusion is
        // a per-user preference on a joint account.
        excludeFromNetWorth: exclusions.has(account.id),
        // The account object itself is owner-only for a grantee.
        canDelete: false,
        futureTransactionsSum: futureSumMap.get(account.id) ?? 0,
      };
    });
  }

  /**
   * Authorize `realUserId` to perform `op` natively on joint account
   * `accountId`. Layers, in order:
   *  1. CrossOwnerAccessService.accountAccessFor -- existence, delegation,
   *     can_read, and the per-op grant flag (404/403 shapes preserved).
   *  2. The grant must be marked is_joint -- a plain shared account is not
   *     natively reachable, and the 404 shape never confirms it exists.
   *  3. For writes, the account type must be in JOINT_WRITABLE_ACCOUNT_TYPES.
   */
  async jointAccessFor(
    realUserId: string,
    accountId: string,
    op: DelegateOperation,
  ): Promise<AccountAccess> {
    const access = await this.crossOwnerAccess.accountAccessFor(
      realUserId,
      accountId,
      op,
    );
    if (access.via === "own") {
      // Own accounts never take the joint path; the caller branched wrongly.
      throw new BadRequestException(
        tr(
          "errors.delegation.jointOwnAccount",
          "This is your own account; joint-account access does not apply to it.",
        ),
      );
    }

    const grant = await withScopedDb(this.dataSource, async (manager) => {
      const delegation = await manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId: access.ownerUserId,
          delegateUserId: realUserId,
          status: "active",
        },
        select: ["id"],
      });
      if (!delegation) return null;
      return manager.getRepository(AccountDelegateGrant).findOne({
        where: {
          delegationId: delegation.id,
          accountId,
          canRead: true,
          isJoint: true,
        },
      });
    });
    if (!grant) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }

    if (
      op !== "read" &&
      !JOINT_WRITABLE_ACCOUNT_TYPES.has(access.account.accountType)
    ) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.jointAccountTypeReadOnly",
          "This account type is shared read-only; only the owner can change its transactions.",
        ),
      );
    }
    return access;
  }

  /**
   * For the owner's list: how many users each of their accounts is jointly
   * shared with, counting only active delegations. Accounts with no joint
   * shares are absent from the map (absent, not zero -- the response field
   * stays undefined for unshared accounts).
   */
  async jointShareCountsForOwner(
    ownerUserId: string,
  ): Promise<Map<string, number>> {
    const rows = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT g.account_id AS "accountId", COUNT(*)::int AS "n"
           FROM account_delegate_grants g
           JOIN account_delegates d ON d.id = g.delegation_id
           WHERE d.owner_user_id = $1
             AND d.status = 'active'
             AND g.can_read AND g.is_joint
           GROUP BY g.account_id`,
          [ownerUserId],
        ) as Promise<Array<{ accountId: string; n: number }>>,
    );
    return new Map(rows.map((r) => [r.accountId, r.n]));
  }

  /** Account ids the grantee excludes from their own net worth. */
  async getNetWorthExclusions(realUserId: string): Promise<Set<string>> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DelegateNetWorthExclusion).find({
        where: { delegateUserId: realUserId },
        select: ["accountId"],
      }),
    );
    return new Set(rows.map((r) => r.accountId));
  }

  /**
   * Set or clear the grantee's net-worth exclusion for a joint account. The
   * joint grant is re-verified INSIDE the write transaction so a revoke
   * racing this call cannot leave an overlay row for an account the caller
   * no longer sees; owners are redirected to the account's own flag.
   */
  async setNetWorthExclusion(
    realUserId: string,
    accountId: string,
    excluded: boolean,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const owned = await manager
        .getRepository(Account)
        .exists({ where: { id: accountId, userId: realUserId } });
      if (owned) {
        throw new BadRequestException(
          tr(
            "errors.delegation.jointOwnAccountNetWorth",
            "Use the account's own net-worth setting for accounts you own.",
          ),
        );
      }

      const delegations = await manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        select: ["id"],
      });
      const grant =
        delegations.length === 0
          ? null
          : await manager.getRepository(AccountDelegateGrant).findOne({
              where: {
                delegationId: In(delegations.map((d) => d.id)),
                accountId,
                canRead: true,
                isJoint: true,
              },
            });
      if (!grant) {
        throw new NotFoundException(
          tr(
            "errors.accounts.accountWithIdNotFound",
            `Account with ID ${accountId} not found`,
            { id: accountId },
          ),
        );
      }

      const repo = manager.getRepository(DelegateNetWorthExclusion);
      const existing = await repo.findOne({
        where: { delegateUserId: realUserId, accountId },
      });
      if (excluded && !existing) {
        await repo.save(repo.create({ delegateUserId: realUserId, accountId }));
      } else if (!excluded && existing) {
        await repo.delete({ id: existing.id });
      }
    });
  }

  /**
   * The owner's category and payee pickers for a joint account's register
   * (reference-data policy R1): a joint row belongs to the owner and may only
   * carry the owner's category/payee ids, so the grantee picks from the
   * owner's lists. Serves picker fields only -- no usage stats, no balances.
   * The capability flags tell the client whether free-text payee entry (an
   * owner-ledger auto-create) is offered.
   */
  async jointReferenceData(
    realUserId: string,
    accountId: string,
  ): Promise<{
    categories: Array<
      Pick<
        Category,
        "id" | "name" | "parentId" | "icon" | "color" | "isIncome" | "isSystem"
      >
    >;
    payees: Array<Pick<Payee, "id" | "name" | "defaultCategoryId">>;
    payeesCanCreate: boolean;
    categoriesCanCreate: boolean;
  }> {
    const access = await this.jointAccessFor(realUserId, accountId, "read");

    const delegation = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId: access.ownerUserId,
          delegateUserId: realUserId,
          status: "active",
        },
      }),
    );

    // Readable in the grantee's own session: the migration-134
    // delegation-scoped read arms cover these tables under enforcement.
    const [categories, payees] = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const ownerCategories = await manager.getRepository(Category).find({
          where: { userId: access.ownerUserId },
          select: [
            "id",
            "name",
            "parentId",
            "icon",
            "color",
            "isIncome",
            "isSystem",
          ],
          order: { name: "ASC" },
        });
        const ownerPayees = await manager.getRepository(Payee).find({
          where: { userId: access.ownerUserId, isActive: true },
          select: ["id", "name", "defaultCategoryId"],
          order: { name: "ASC" },
        });
        return [ownerCategories, ownerPayees] as const;
      },
    );

    return {
      categories,
      payees,
      payeesCanCreate: !!delegation?.payeesCanCreate,
      categoriesCanCreate: !!delegation?.categoriesCanCreate,
    };
  }

  /** Grant flags masked by the v1 account-type write policy. */
  private effectivePermissions(
    account: Account,
    granted: JointPermissions,
  ): JointPermissions {
    if (!JOINT_WRITABLE_ACCOUNT_TYPES.has(account.accountType)) {
      return { canCreate: false, canEdit: false, canDelete: false };
    }
    return { ...granted };
  }

  private userLabel(
    user: Pick<User, "firstName" | "lastName" | "email" | "id">,
  ): string {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return name || user.email || user.id;
  }
}
