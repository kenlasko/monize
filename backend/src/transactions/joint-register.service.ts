import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";
import { Transaction } from "./entities/transaction.entity";
import { TransactionsService } from "./transactions.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";
import { AccountDelegate } from "../delegation/entities/account-delegate.entity";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";

/**
 * Grantee writes on a joint account's register (joint-accounts spec, W1).
 *
 * A joint row belongs to the OWNER: the row is created/updated/deleted by
 * running the existing TransactionsService operation with the owner's user id
 * under the audited withSystemContext bypass -- reusing its balance math,
 * validation and net-worth recalc wholesale -- but only AFTER this service
 * has fully decided authorization (joint grant + op flag + account-type
 * policy) and the v1 reference-data policy:
 *
 *  - category/payee ids are validated against the OWNER's ledger (the reused
 *    operation does this by construction, since it runs as the owner);
 *  - free-text payee entry is allowed only when the delegation grants
 *    payees_can_create (it auto-creates on the owner's ledger);
 *  - no grantee tags, no splits, no account moves, no transfer rows -- each
 *    rejected before anything is written.
 *
 * Every check that can refuse runs before the system-context window opens;
 * nothing user-controlled selects rows inside it beyond the validated ids.
 */
@Injectable()
export class JointRegisterService {
  constructor(
    private dataSource: DataSource,
    private jointAccounts: JointAccountsService,
    private transactionsService: TransactionsService,
  ) {}

  async create(
    realUserId: string,
    dto: CreateTransactionDto,
  ): Promise<Transaction> {
    this.assertPlainDto(dto);
    const access = await this.jointAccounts.jointAccessFor(
      realUserId,
      dto.accountId,
      "create",
    );
    const createPayeeIfMissing = await this.resolveFreeTextPayeePolicy(
      realUserId,
      access.ownerUserId,
      dto,
    );
    return withSystemContext(() =>
      this.transactionsService.create(access.ownerUserId, dto, {
        createPayeeIfMissing,
        // The grantee is the actor and the owner the row's user: the owner's
        // structural rules (transfer, split) must not run on it, or the
        // grantee would move, and be shown, the owner's other accounts.
        actorIsNotOwner: true,
      }),
    );
  }

  async update(
    realUserId: string,
    transactionId: string,
    dto: UpdateTransactionDto,
  ): Promise<Transaction> {
    this.assertPlainDto(dto);
    const row = await this.loadRowById(transactionId);
    if (!row) throw this.transactionNotFound(transactionId);
    this.assertPlainRow(row, transactionId);
    if (dto.accountId && dto.accountId !== row.accountId) {
      // Account moves are owner-only: the row must stay in the joint account.
      throw new ForbiddenException(
        tr(
          "errors.transactions.jointAccountMoveLocked",
          "Transactions in a shared account cannot be moved to another account.",
        ),
      );
    }
    const access = await this.jointAccounts.jointAccessFor(
      realUserId,
      row.accountId,
      "edit",
    );
    const createPayeeIfMissing = await this.resolveFreeTextPayeePolicy(
      realUserId,
      access.ownerUserId,
      dto,
    );
    return withSystemContext(() =>
      this.transactionsService.update(access.ownerUserId, transactionId, dto, {
        createPayeeIfMissing,
      }),
    );
  }

  async remove(realUserId: string, transactionId: string): Promise<void> {
    const row = await this.loadRowById(transactionId);
    if (!row) throw this.transactionNotFound(transactionId);
    this.assertPlainRow(row, transactionId);
    const access = await this.jointAccounts.jointAccessFor(
      realUserId,
      row.accountId,
      "delete",
    );
    return withSystemContext(() =>
      this.transactionsService.remove(access.ownerUserId, transactionId),
    );
  }

  /** Cleared toggle: an edit-class status flip on the owner's row. */
  async markCleared(
    realUserId: string,
    transactionId: string,
    isCleared: boolean,
  ): Promise<Transaction> {
    const row = await this.loadRowById(transactionId);
    if (!row) throw this.transactionNotFound(transactionId);
    const access = await this.jointAccounts.jointAccessFor(
      realUserId,
      row.accountId,
      "edit",
    );
    return withSystemContext(() =>
      this.transactionsService.markCleared(
        access.ownerUserId,
        transactionId,
        isCleared,
      ),
    );
  }

  /**
   * The v1 free-text payee rule: a name without a payeeId either auto-creates
   * on the owner's ledger (delegation grants payees_can_create) or is
   * rejected -- never stored as unlinked free text, which would put
   * grantee-typed strings on owner rows with no way to manage them.
   */
  private async resolveFreeTextPayeePolicy(
    realUserId: string,
    ownerUserId: string,
    dto: { payeeId?: string; payeeName?: string },
  ): Promise<boolean> {
    if (dto.payeeId || !dto.payeeName?.trim()) return false;
    const delegation = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId,
          delegateUserId: realUserId,
          status: "active",
        },
        select: ["id", "payeesCanCreate"],
      }),
    );
    if (!delegation?.payeesCanCreate) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.jointPayeeCreateNotGranted",
          "The account owner has not granted you permission to create payees. Pick one of their existing payees instead.",
        ),
      );
    }
    return true;
  }

  /** DTO shapes a grantee may not write to an owner's row (R1 policy). */
  private assertPlainDto(dto: { tagIds?: string[]; splits?: unknown[] }): void {
    if (dto.tagIds && dto.tagIds.length > 0) {
      throw new BadRequestException(
        tr(
          "errors.delegation.jointTagsNotAllowed",
          "Tags are personal, so they cannot be set on a shared account's transactions.",
        ),
      );
    }
    if (dto.splits && dto.splits.length > 0) {
      throw new BadRequestException(
        tr(
          "errors.delegation.jointSplitsNotAllowed",
          "Split transactions in a shared account can only be managed by the owner.",
        ),
      );
    }
  }

  /** Row shapes a grantee may not mutate through the plain register path. */
  private assertPlainRow(row: Transaction, transactionId: string): void {
    if (row.isTransfer) {
      throw new BadRequestException(
        tr(
          "errors.delegation.jointTransferRowLocked",
          "This is a transfer. Use the transfer editor instead.",
        ),
      );
    }
    if (row.isSplit || row.parentTransactionId) {
      throw new BadRequestException(
        tr(
          "errors.delegation.jointSplitsNotAllowed",
          "Split transactions in a shared account can only be managed by the owner.",
        ),
      );
    }
    void transactionId;
  }

  /**
   * Whether the row exists under the caller's own scope. The controller uses
   * this to branch between the ordinary owner-scoped path and the joint
   * path, instead of catching NotFoundException -- the owner-scoped
   * operations also 404 on missing categories/payees, and a catch would
   * misroute those onto the joint path.
   */
  ownsRow(userId: string, id: string): Promise<boolean> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Transaction).exists({ where: { id, userId } }),
    );
  }

  /**
   * Authorization-decision read (loadLegById pattern): the row is loaded by
   * id with no user filter, only so its accountId can be authorized via
   * jointAccessFor before any derived data or mutation proceeds.
   */
  private loadRowById(id: string): Promise<Transaction | null> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (m) =>
        m.getRepository(Transaction).findOne({ where: { id } }),
      ),
    );
  }

  /** Same 404 shape as the owner-scoped lookup. */
  private transactionNotFound(id: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.transactions.notFoundById",
        `Transaction with ID ${id} not found`,
        { id },
      ),
    );
  }
}
