import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, Not, DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

import {
  AccountDelegate,
  DelegationStatus,
} from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { hashToken } from "../auth/crypto.util";
import { generateReadablePassword } from "../admin/utils/password-generator";
import { EmailService } from "../notifications/email.service";
import { delegateInviteTemplate } from "../notifications/email-templates";
import { ConfigService } from "@nestjs/config";
import { CreateDelegateDto } from "./dto/create-delegate.dto";
import { AccountGrantDto } from "./dto/set-grants.dto";
import {
  DelegateResource,
  DelegateCapabilityOp,
  DelegateSection,
} from "./decorators/delegate-access.decorator";

export interface ResourceCapabilities {
  create: boolean;
  edit: boolean;
  delete: boolean;
}
export interface DelegateCapabilitySet {
  payees: ResourceCapabilities;
  categories: ResourceCapabilities;
  tags: ResourceCapabilities;
}

export interface DelegateSectionSet {
  bills: boolean;
  investments: boolean;
  budgets: boolean;
  reports: boolean;
  ai: boolean;
}

const SECTION_FIELD: Record<DelegateSection, keyof AccountDelegate> = {
  bills: "billsCanRead",
  investments: "investmentsCanRead",
  budgets: "budgetsCanRead",
  reports: "reportsCanRead",
  ai: "aiCanRead",
};

export type DelegateOperation = "read" | "create" | "edit" | "delete";

/**
 * Distinct message so the frontend can route a delegate to 2FA enrollment
 * before letting them act as an owner who requires 2FA.
 */
export const DELEGATE_2FA_REQUIRED = "DELEGATE_2FA_REQUIRED";

export interface AvailableContext {
  userId: string;
  label: string;
  isSelf: boolean;
  ownerHas2FA: boolean;
}

@Injectable()
export class DelegationService {
  private readonly logger = new Logger(DelegationService.name);
  private readonly BCRYPT_ROUNDS = 12;

  constructor(
    @InjectRepository(AccountDelegate)
    private delegatesRepository: Repository<AccountDelegate>,
    @InjectRepository(AccountDelegateGrant)
    private grantsRepository: Repository<AccountDelegateGrant>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    private emailService: EmailService,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {}

  // --- Context resolution (used by JwtStrategy and the guard) ---

  /**
   * Validate that `delegateUserId` may currently act as `actingAsUserId` via
   * `delegationId`. Throws (fail closed) on any mismatch, revoked/inactive
   * delegation, inactive owner, or unmet 2FA requirement.
   */
  async validateActingContext(args: {
    delegateUserId: string;
    actingAsUserId: string;
    delegationId: string;
  }): Promise<AccountDelegate> {
    const { delegateUserId, actingAsUserId, delegationId } = args;

    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId },
    });

    if (
      !delegation ||
      delegation.status !== "active" ||
      delegation.delegateUserId !== delegateUserId ||
      delegation.ownerUserId !== actingAsUserId
    ) {
      throw new UnauthorizedException("Delegated access is no longer valid");
    }

    const owner = await this.usersRepository.findOne({
      where: { id: actingAsUserId },
    });
    if (!owner || !owner.isActive) {
      throw new UnauthorizedException("Delegated access is no longer valid");
    }

    if (await this.delegateMustEnrollOwn2FA(actingAsUserId, delegateUserId)) {
      throw new UnauthorizedException(DELEGATE_2FA_REQUIRED);
    }

    return delegation;
  }

  /**
   * True when the owner requires 2FA but the delegate has not enrolled their
   * own 2FA. (TOTP secrets are per-user and never shared.)
   */
  async delegateMustEnrollOwn2FA(
    ownerUserId: string,
    delegateUserId: string,
  ): Promise<boolean> {
    const [owner, ownerPref] = await Promise.all([
      this.usersRepository.findOne({ where: { id: ownerUserId } }),
      this.preferencesRepository.findOne({ where: { userId: ownerUserId } }),
    ]);
    const ownerRequires2FA = !!(
      ownerPref?.twoFactorEnabled && owner?.twoFactorSecret
    );
    if (!ownerRequires2FA) return false;

    const [delegate, delegatePref] = await Promise.all([
      this.usersRepository.findOne({ where: { id: delegateUserId } }),
      this.preferencesRepository.findOne({ where: { userId: delegateUserId } }),
    ]);
    const delegateHas2FA = !!(
      delegatePref?.twoFactorEnabled && delegate?.twoFactorSecret
    );
    return !delegateHas2FA;
  }

  /** True if the user is a delegate for at least one owner. */
  async isDelegateUser(userId: string): Promise<boolean> {
    const count = await this.delegatesRepository.count({
      where: { delegateUserId: userId },
    });
    return count > 0;
  }

  async hasReadAccess(
    delegationId: string,
    accountId: string,
  ): Promise<boolean> {
    const grant = await this.grantsRepository.findOne({
      where: { delegationId, accountId, canRead: true },
    });
    return !!grant;
  }

  /** The account a transaction belongs to, or null if it does not exist. */
  async accountIdForTransaction(transactionId: string): Promise<string | null> {
    const tx = await this.transactionsRepository.findOne({
      where: { id: transactionId },
      select: ["accountId"],
    });
    return tx?.accountId ?? null;
  }

  /**
   * Both account ids involved in a transfer identified by either leg's
   * transaction id (this leg + the linked leg). Empty if the transaction
   * does not exist.
   */
  async accountIdsForTransfer(transactionId: string): Promise<string[]> {
    const tx = await this.transactionsRepository.findOne({
      where: { id: transactionId },
      select: ["accountId", "linkedTransactionId"],
    });
    if (!tx) return [];
    const ids = new Set<string>([tx.accountId]);
    if (tx.linkedTransactionId) {
      const linked = await this.transactionsRepository.findOne({
        where: { id: tx.linkedTransactionId },
        select: ["accountId"],
      });
      if (linked) ids.add(linked.accountId);
    }
    return [...ids];
  }

  /**
   * Every account a scheduled transaction touches: its own account plus the
   * transfer counterpart when it is a transfer. Empty if the row does not
   * exist (the owner-scoped service then returns 404).
   */
  async accountIdsForScheduled(scheduledId: string): Promise<string[]> {
    const st = await this.scheduledTransactionsRepository.findOne({
      where: { id: scheduledId },
      select: ["accountId", "transferAccountId", "isTransfer"],
    });
    if (!st) return [];
    const ids = new Set<string>([st.accountId]);
    if (st.isTransfer && st.transferAccountId) {
      ids.add(st.transferAccountId);
    }
    return [...ids];
  }

  async readableAccountIds(delegationId: string): Promise<string[]> {
    const grants = await this.grantsRepository.find({
      where: { delegationId, canRead: true },
      select: ["accountId"],
    });
    return grants.map((g) => g.accountId);
  }

  /**
   * Whether the delegate can READ at least one account whose activity shows
   * in the Transactions section (i.e. any non-investment account they were
   * granted). Drives the delegate Transactions nav/route visibility.
   */
  async hasTransactionalAccess(delegationId: string): Promise<boolean> {
    const readable = await this.readableAccountIds(delegationId);
    if (readable.length === 0) return false;
    const count = await this.accountsRepository.count({
      where: { id: In(readable), accountType: Not(AccountType.INVESTMENT) },
    });
    return count > 0;
  }

  /**
   * Whether the delegate can READ at least one account at all. Drives the
   * delegate Accounts nav/route visibility (any granted account, including
   * investment accounts, makes the Accounts section reachable).
   */
  async hasAnyAccountAccess(delegationId: string): Promise<boolean> {
    const count = await this.grantsRepository.count({
      where: { delegationId, canRead: true },
    });
    return count > 0;
  }

  // --- Login / switch context ---

  /**
   * Contexts the authenticated user can operate in. Returns an empty array
   * for a normal user with no delegations (so login behaviour is unchanged).
   */
  async getAvailableContexts(userId: string): Promise<AvailableContext[]> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) return [];

    const delegations = await this.delegatesRepository.find({
      where: { delegateUserId: user.id, status: "active" },
      relations: ["owner"],
    });

    if (delegations.length === 0) return [];

    const ownsData = await this.accountsRepository.exists({
      where: { userId: user.id },
    });

    const contexts: AvailableContext[] = [];
    if (ownsData) {
      contexts.push({
        userId: user.id,
        label: this.userLabel(user),
        isSelf: true,
        ownerHas2FA: false,
      });
    }

    for (const d of delegations) {
      contexts.push({
        userId: d.ownerUserId,
        label: d.owner ? this.userLabel(d.owner) : d.ownerUserId,
        isSelf: false,
        ownerHas2FA: await this.delegateMustEnrollOwn2FA(
          d.ownerUserId,
          user.id,
        ),
      });
    }
    return contexts;
  }

  /**
   * Resolve a target context for /auth/switch-context. Returns null context
   * for "self"; otherwise the validated active delegation.
   */
  async resolveSwitchTarget(
    delegateUserId: string,
    targetUserId: string,
  ): Promise<AccountDelegate | null> {
    if (targetUserId === delegateUserId) {
      return null;
    }
    const delegation = await this.delegatesRepository.findOne({
      where: {
        delegateUserId,
        ownerUserId: targetUserId,
        status: "active",
      },
    });
    if (!delegation) {
      throw new ForbiddenException("No active delegation for that account");
    }
    if (await this.delegateMustEnrollOwn2FA(targetUserId, delegateUserId)) {
      throw new ForbiddenException(DELEGATE_2FA_REQUIRED);
    }
    return delegation;
  }

  private userLabel(user: User): string {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return name || user.email || user.id;
  }

  // --- Owner-facing management ---

  async listDelegates(ownerUserId: string) {
    const delegations = await this.delegatesRepository.find({
      where: {
        ownerUserId,
        status: In(["active", "pending"] as DelegationStatus[]),
      },
      relations: ["delegate", "grants"],
      order: { createdAt: "DESC" },
    });
    return delegations.map((d) => ({
      id: d.id,
      status: d.status,
      createdAt: d.createdAt,
      delegate: {
        id: d.delegateUserId,
        email: d.delegate?.email ?? null,
        firstName: d.delegate?.firstName ?? null,
        lastName: d.delegate?.lastName ?? null,
        hasPassword: !!d.delegate?.passwordHash,
      },
      grants: (d.grants ?? [])
        .filter((g) => g.canRead)
        .map((g) => ({
          accountId: g.accountId,
          canRead: g.canRead,
          canCreate: g.canCreate,
          canEdit: g.canEdit,
          canDelete: g.canDelete,
        })),
      capabilities: this.toCapabilitySet(d),
      sections: this.toSectionSet(d),
    }));
  }

  private toSectionSet(d?: AccountDelegate | null): DelegateSectionSet {
    return {
      bills: !!d?.billsCanRead,
      investments: !!d?.investmentsCanRead,
      budgets: !!d?.budgetsCanRead,
      reports: !!d?.reportsCanRead,
      ai: !!d?.aiCanRead,
    };
  }

  private toCapabilitySet(d?: AccountDelegate | null): DelegateCapabilitySet {
    return {
      payees: {
        create: !!d?.payeesCanCreate,
        edit: !!d?.payeesCanEdit,
        delete: !!d?.payeesCanDelete,
      },
      categories: {
        create: !!d?.categoriesCanCreate,
        edit: !!d?.categoriesCanEdit,
        delete: !!d?.categoriesCanDelete,
      },
      tags: {
        create: !!d?.tagsCanCreate,
        edit: !!d?.tagsCanEdit,
        delete: !!d?.tagsCanDelete,
      },
    };
  }

  /** Whether the delegation may perform `operation` on `resource`. */
  async hasCapability(
    delegationId: string,
    resource: DelegateResource,
    operation: DelegateCapabilityOp,
  ): Promise<boolean> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, status: "active" },
    });
    if (!delegation) return false;
    const opKey =
      operation === "create"
        ? "Create"
        : operation === "edit"
          ? "Edit"
          : "Delete";
    const field = `${resource}Can${opKey}` as keyof AccountDelegate;
    return !!delegation[field];
  }

  /** All granular capabilities for an active delegation (all false if none). */
  async getCapabilities(delegationId: string): Promise<DelegateCapabilitySet> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, status: "active" },
    });
    return this.toCapabilitySet(delegation);
  }

  /** Whether the active delegation was granted READ on `section`. */
  async hasSection(
    delegationId: string,
    section: DelegateSection,
  ): Promise<boolean> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, status: "active" },
    });
    if (!delegation) return false;
    return !!delegation[SECTION_FIELD[section]];
  }

  /** All section grants for an active delegation (all false if none). */
  async getSections(delegationId: string): Promise<DelegateSectionSet> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, status: "active" },
    });
    return this.toSectionSet(delegation);
  }

  async setSectionGrants(
    ownerUserId: string,
    delegationId: string,
    sections: Partial<
      Record<
        | "billsCanRead"
        | "investmentsCanRead"
        | "budgetsCanRead"
        | "reportsCanRead"
        | "aiCanRead",
        boolean
      >
    >,
  ): Promise<void> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, ownerUserId },
    });
    if (!delegation) {
      throw new NotFoundException("Delegate not found");
    }
    for (const [key, value] of Object.entries(sections)) {
      if (value !== undefined) {
        (delegation as unknown as Record<string, boolean>)[key] = value;
      }
    }
    await this.delegatesRepository.save(delegation);
  }

  async setCapabilities(
    ownerUserId: string,
    delegationId: string,
    caps: Partial<
      Record<
        | "payeesCanCreate"
        | "payeesCanEdit"
        | "payeesCanDelete"
        | "categoriesCanCreate"
        | "categoriesCanEdit"
        | "categoriesCanDelete"
        | "tagsCanCreate"
        | "tagsCanEdit"
        | "tagsCanDelete",
        boolean
      >
    >,
  ): Promise<void> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, ownerUserId },
    });
    if (!delegation) {
      throw new NotFoundException("Delegate not found");
    }
    for (const [key, value] of Object.entries(caps)) {
      if (value !== undefined) {
        (delegation as unknown as Record<string, boolean>)[key] = value;
      }
    }
    await this.delegatesRepository.save(delegation);
  }

  /**
   * Whether the delegation grants `operation` on `accountId`. READ is implied
   * by any stored grant (rows are only written when canRead is true).
   */
  async hasAccountPermission(
    delegationId: string,
    accountId: string,
    operation: DelegateOperation,
  ): Promise<boolean> {
    const grant = await this.grantsRepository.findOne({
      where: { delegationId, accountId, canRead: true },
    });
    if (!grant) return false;
    switch (operation) {
      case "read":
        return true;
      case "create":
        return grant.canCreate;
      case "edit":
        return grant.canEdit;
      case "delete":
        return grant.canDelete;
    }
  }

  /**
   * Whether a Monize login already exists for this email (existing full
   * account or a delegate of another owner). Used by the Add-delegate UI
   * to skip the password / invite controls -- such a user keeps their own
   * credentials and is only granted the additional shared access.
   */
  async delegateEmailExists(email: string): Promise<boolean> {
    const normalized = email.toLowerCase().trim();
    const user = await this.usersRepository.findOne({
      where: { email: normalized },
    });
    return !!user;
  }

  async createDelegate(ownerUserId: string, dto: CreateDelegateDto) {
    const email = dto.email.toLowerCase().trim();

    const owner = await this.usersRepository.findOne({
      where: { id: ownerUserId },
    });
    if (!owner) throw new NotFoundException("User not found");
    if (owner.email && owner.email.toLowerCase().trim() === email) {
      throw new BadRequestException("You cannot delegate access to yourself");
    }

    let temporaryPassword: string | undefined;
    let inviteToken: string | undefined;

    return this.dataSource.transaction(async (manager) => {
      let delegateUser = await manager.findOne(User, { where: { email } });
      const isNew = !delegateUser;

      if (delegateUser && delegateUser.id === ownerUserId) {
        throw new BadRequestException("You cannot delegate access to yourself");
      }

      // An existing user that is a full account in its own right (owns data,
      // owns delegations, is an admin, or is SSO) must NEVER have its
      // credentials touched here -- that would be account takeover. They log
      // in with their own credentials; the owner only links the delegation.
      // New users and pure-delegate identities are owner-managed, so the
      // owner may set their password / send an invite.
      let mayManageCredentials = true;
      if (delegateUser) {
        if (delegateUser.oidcSubject || delegateUser.role === "admin") {
          mayManageCredentials = false;
        } else {
          const [ownsAccounts, ownsDelegations] = await Promise.all([
            manager.count(Account, {
              where: { userId: delegateUser.id },
            }),
            manager.count(AccountDelegate, {
              where: { ownerUserId: delegateUser.id },
            }),
          ]);
          if (ownsAccounts > 0 || ownsDelegations > 0) {
            mayManageCredentials = false;
          }
        }
      }

      if (!delegateUser) {
        delegateUser = manager.create(User, {
          email,
          firstName: dto.firstName ?? null,
          lastName: dto.lastName ?? null,
          authProvider: "local",
          role: "user",
        });
      }

      if (mayManageCredentials) {
        if (dto.sendInvite) {
          if (!this.emailService.getStatus().configured) {
            throw new BadRequestException(
              "SMTP is not configured. Set a password for the delegate instead.",
            );
          }
          const rawToken = crypto.randomBytes(32).toString("hex");
          delegateUser.resetToken = hashToken(rawToken);
          delegateUser.resetTokenExpiry = new Date(
            Date.now() + 24 * 60 * 60 * 1000,
          );
          // The invitee sets their own password via the reset link.
          inviteToken = rawToken;
        } else if (dto.password) {
          delegateUser.passwordHash = await bcrypt.hash(
            dto.password,
            this.BCRYPT_ROUNDS,
          );
          delegateUser.mustChangePassword = false;
          delegateUser.resetToken = null;
          delegateUser.resetTokenExpiry = null;
          delegateUser.failedLoginAttempts = 0;
          delegateUser.lockedUntil = null;
        } else if (isNew || !delegateUser.passwordHash) {
          // Guarantee the delegate can actually sign in.
          temporaryPassword = generateReadablePassword();
          delegateUser.passwordHash = await bcrypt.hash(
            temporaryPassword,
            this.BCRYPT_ROUNDS,
          );
          delegateUser.mustChangePassword = true;
          delegateUser.resetToken = null;
          delegateUser.resetTokenExpiry = null;
          delegateUser.failedLoginAttempts = 0;
          delegateUser.lockedUntil = null;
        }
      }

      delegateUser = await manager.save(delegateUser);

      let delegation = await manager.findOne(AccountDelegate, {
        where: { ownerUserId, delegateUserId: delegateUser.id },
      });
      if (delegation) {
        if (delegation.status === "active") {
          throw new ConflictException(
            "That user is already a delegate for your account",
          );
        }
        delegation.status = "active";
        delegation.revokedAt = null;
      } else {
        delegation = manager.create(AccountDelegate, {
          ownerUserId,
          delegateUserId: delegateUser.id,
          status: "active",
        });
      }
      delegation = await manager.save(delegation);

      if (inviteToken) {
        const frontendUrl = this.configService.get<string>(
          "PUBLIC_APP_URL",
          "http://localhost:3000",
        );
        const inviteUrl = `${frontendUrl}/reset-password?token=${inviteToken}`;
        this.emailService
          .sendMail(
            email,
            "You have been invited to Monize",
            delegateInviteTemplate(
              dto.firstName || "",
              this.userLabel(owner),
              inviteUrl,
            ),
          )
          .catch((err) =>
            this.logger.warn(
              `Failed to send delegate invite email: ${
                err instanceof Error ? err.message : err
              }`,
            ),
          );
      }

      return {
        id: delegation.id,
        delegateUserId: delegateUser.id,
        email,
        temporaryPassword,
        invited: !!inviteToken,
      };
    });
  }

  async revokeDelegate(
    ownerUserId: string,
    delegationId: string,
  ): Promise<void> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, ownerUserId },
    });
    if (!delegation) {
      throw new NotFoundException("Delegate not found");
    }
    const delegateUserId = delegation.delegateUserId;

    await this.dataSource.transaction(async (manager) => {
      // Hard-delete the delegation. FK cascades remove its grants and any
      // refresh tokens scoped to it, so live delegate sessions acting via
      // this delegation are immediately invalidated.
      await manager.delete(AccountDelegate, { id: delegationId });

      // Entirely remove the delegate's login unless it has another reason to
      // exist: a delegation elsewhere, its own data, it owns a delegation, or
      // it is an admin (i.e. it is a full user in its own right).
      const [otherDelegations, ownsAccounts, ownsDelegations] =
        await Promise.all([
          manager.count(AccountDelegate, { where: { delegateUserId } }),
          manager.count(Account, { where: { userId: delegateUserId } }),
          manager.count(AccountDelegate, {
            where: { ownerUserId: delegateUserId },
          }),
        ]);
      const delegateUser = await manager.findOne(User, {
        where: { id: delegateUserId },
      });

      if (
        otherDelegations === 0 &&
        ownsAccounts === 0 &&
        ownsDelegations === 0 &&
        delegateUser?.role !== "admin"
      ) {
        // FK ON DELETE CASCADE cleans preferences, tokens, trusted devices.
        await manager.delete(User, { id: delegateUserId });
      }
    });
  }

  async setGrants(
    ownerUserId: string,
    delegationId: string,
    grants: AccountGrantDto[],
  ): Promise<void> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, ownerUserId },
    });
    if (!delegation) {
      throw new NotFoundException("Delegate not found");
    }

    // READ is the minimum and a prerequisite for CREATE/EDIT/DELETE.
    for (const g of grants) {
      if (!g.canRead && (g.canCreate || g.canEdit || g.canDelete)) {
        throw new BadRequestException(
          "READ access is required for CREATE, EDIT or DELETE",
        );
      }
    }

    // Only grants that include READ represent actual access.
    const readable = grants.filter((g) => g.canRead);
    const accountIds = readable.map((g) => g.accountId);

    if (accountIds.length > 0) {
      const owned = await this.accountsRepository.find({
        where: { id: In(accountIds), userId: ownerUserId },
        select: ["id"],
      });
      if (owned.length !== accountIds.length) {
        throw new ForbiddenException(
          "One or more accounts do not belong to you",
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AccountDelegateGrant, { delegationId });
      if (readable.length > 0) {
        const rows = readable.map((g) =>
          manager.create(AccountDelegateGrant, {
            delegationId,
            accountId: g.accountId,
            canRead: true,
            canCreate: !!g.canCreate,
            canEdit: !!g.canEdit,
            canDelete: !!g.canDelete,
          }),
        );
        await manager.save(rows);
      }
    });
  }

  async resetDelegatePassword(
    ownerUserId: string,
    delegationId: string,
  ): Promise<{ temporaryPassword: string }> {
    const delegation = await this.delegatesRepository.findOne({
      where: { id: delegationId, ownerUserId, status: "active" },
    });
    if (!delegation) {
      throw new NotFoundException("Delegate not found");
    }

    const delegate = await this.usersRepository.findOne({
      where: { id: delegation.delegateUserId },
    });
    if (!delegate) {
      throw new NotFoundException("Delegate not found");
    }
    if (delegate.oidcSubject) {
      throw new BadRequestException(
        "Cannot reset password for an SSO delegate account",
      );
    }

    const temporaryPassword = generateReadablePassword();
    delegate.passwordHash = await bcrypt.hash(
      temporaryPassword,
      this.BCRYPT_ROUNDS,
    );
    delegate.mustChangePassword = true;
    delegate.resetToken = null;
    delegate.resetTokenExpiry = null;
    // Owner-driven reset is an explicit recovery action: clear any lockout
    // so a locked-out delegate can sign in with the new password.
    delegate.failedLoginAttempts = 0;
    delegate.lockedUntil = null;
    await this.usersRepository.save(delegate);

    await this.refreshTokensRepository.update(
      { userId: delegate.id, isRevoked: false },
      { isRevoked: true },
    );

    return { temporaryPassword };
  }
}
