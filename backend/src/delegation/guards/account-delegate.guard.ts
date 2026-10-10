import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { tr } from "../../i18n/translate";
import {
  ALLOW_DELEGATE_KEY,
  DELEGATED_ACCOUNT_PARAM_KEY,
  DELEGATED_BODY_ACCOUNTS_KEY,
  DELEGATED_TRANSACTION_PARAM_KEY,
  DELEGATED_TRANSFER_BODY_KEY,
  DELEGATED_TRANSFER_PARAM_KEY,
  DELEGATED_SCHEDULED_PARAM_KEY,
  DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY,
  DELEGATE_OPERATION_KEY,
  DELEGATE_CAPABILITY_KEY,
  DELEGATE_SECTION_KEY,
  DELEGATE_FULL_SCOPE_KEY,
  DelegateOperation,
  DelegateCapabilityReq,
  DelegateSection,
} from "../decorators/delegate-access.decorator";
import { DelegationService } from "../delegation.service";
import { CrossOwnerAccessService } from "../cross-owner-access.service";
import { withDelegateContext } from "../../common/db/with-context";

const SECTION_LABELS: Record<DelegateSection, string> = {
  bills: "Bills & Deposits",
  investments: "Investments",
  budgets: "Budgets",
  reports: "Reports",
  ai: "AI Assistant",
};

const RESOURCE_LABELS: Record<DelegateCapabilityReq["resource"], string> = {
  payees: "payees",
  categories: "categories",
  tags: "tags",
};

/**
 * Every string a body path names. A segment ending in `[]` walks an array; a
 * value of any other shape is skipped here and rejected by the route's DTO
 * validation (which runs after this guard) before the handler sees it.
 */
function collectBodyStrings(body: unknown, path: string): string[] {
  let nodes: unknown[] = [body];
  for (const segment of path.split(".")) {
    const walksArray = segment.endsWith("[]");
    const key = walksArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const value = (node as Record<string, unknown>)[key];
      if (!walksArray) {
        next.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) next.push(item);
      }
    }
    nodes = next;
  }
  return nodes.filter((value): value is string => typeof value === "string");
}

/**
 * Fail-closed enforcement for delegate ("acting as owner") requests.
 *
 * Registered globally. Because NestJS runs global guards before route-level
 * AuthGuard('jwt'), this guard does NOT rely on req.user being populated --
 * it independently reads and verifies the access token. This keeps a single
 * ordering-independent choke point.
 *
 * Behaviour:
 *  - No token / invalid token / non-delegate token: returns true. The normal
 *    AuthGuard('jwt') still authenticates/authorizes the request as before;
 *    normal users and owners are completely unaffected.
 *  - Delegate (acting) token: the route MUST be @AllowDelegate(); otherwise
 *    403. If the route is @DelegatedAccountParam(), an active READ grant for
 *    the referenced account is additionally required.
 */
@Injectable()
export class AccountDelegateGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private delegationService: DelegationService,
    private crossOwnerAccess: CrossOwnerAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) return true;

    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      return true; // AuthGuard('jwt') will reject it
    }

    if (payload?.type === "2fa_pending") return true;
    if (!payload?.actingAsUserId || !payload?.delegationId) {
      return true; // acting as self / normal user
    }

    // RLS: global guards run before AuthGuard('jwt') and before the
    // RequestContextInterceptor's scope exists, so every DelegationService read
    // below would have no ambient identity to spend. The verified token names
    // both parties -- `actingAsUserId` is the owner, `sub` is the delegate --
    // and the grant/account rows these checks read are keyed by one or the
    // other, so seed both GUCs rather than a single-id user context.
    return withDelegateContext(payload.actingAsUserId, payload.sub, () =>
      this.checkDelegateAccess(context, req, payload),
    );
  }

  private async checkDelegateAccess(
    context: ExecutionContext,
    req: Request,
    payload: any,
  ): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DELEGATE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.actionNotAvailableAsDelegate",
          "This action isn't available while you're acting on behalf of another user. Only the account owner can do this.",
        ),
      );
    }

    const operation =
      this.reflector.getAllAndOverride<DelegateOperation>(
        DELEGATE_OPERATION_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? "read";

    const accountParamKey = this.reflector.getAllAndOverride<string>(
      DELEGATED_ACCOUNT_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (accountParamKey) {
      const accountId = this.resolveAccountId(req, accountParamKey);
      if (accountId) {
        await this.assertPermission(payload.delegationId, accountId, operation);
      }
    }

    const txParamKey = this.reflector.getAllAndOverride<string>(
      DELEGATED_TRANSACTION_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (txParamKey) {
      const txId = this.resolveAccountId(req, txParamKey);
      if (txId) {
        const accountId =
          await this.delegationService.accountIdForTransaction(txId);
        // Unknown transaction: let the owner-scoped service return 404.
        if (accountId) {
          await this.assertPermission(
            payload.delegationId,
            accountId,
            operation,
          );
        }
      }
    }

    const transferBodyKeys = this.reflector.getAllAndOverride<[string, string]>(
      DELEGATED_TRANSFER_BODY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (transferBodyKeys) {
      // A transfer touches two accounts; the delegate needs the operation on
      // BOTH ends (no moving money via an account they cannot access).
      for (const key of transferBodyKeys) {
        const accountId = this.resolveAccountId(req, key);
        if (accountId) {
          await this.assertTransferPermission(payload, accountId, operation);
        }
      }
    }

    const bodyAccountPaths = this.reflector.getAllAndOverride<string[]>(
      DELEGATED_BODY_ACCOUNTS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (bodyAccountPaths) {
      // Every other account the body names (a split's transfer target, a
      // re-pointed account on an edit): the write lands there too, as the
      // owner, so it needs the grant exactly like the primary account. An id
      // that is not granted throws, so the distinct ids checked are bounded
      // by the delegation's grants however long a request's arrays are.
      const accountIds = new Set(
        bodyAccountPaths.flatMap((path) => collectBodyStrings(req.body, path)),
      );
      for (const accountId of accountIds) {
        await this.assertPermission(payload.delegationId, accountId, operation);
      }
    }

    const transferParamKey = this.reflector.getAllAndOverride<string>(
      DELEGATED_TRANSFER_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (transferParamKey) {
      const txId = this.resolveAccountId(req, transferParamKey);
      if (txId) {
        const accountIds =
          await this.delegationService.accountIdsForTransfer(txId);
        // Unknown transfer: let the owner-scoped service return 404.
        for (const accountId of accountIds) {
          await this.assertTransferPermission(payload, accountId, operation);
        }
      }
    }

    const scheduledParamKey = this.reflector.getAllAndOverride<string>(
      DELEGATED_SCHEDULED_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (scheduledParamKey) {
      const scheduledId = this.resolveAccountId(req, scheduledParamKey);
      if (scheduledId) {
        const accountIds =
          await this.delegationService.accountIdsForScheduled(scheduledId);
        // Unknown scheduled txn: let the owner-scoped service return 404.
        // READ only needs the primary account (accountIds[0]); the transfer
        // counterpart is masked by the interceptor, not blocked. WRITES must
        // hold the op on EVERY account the schedule posts into -- transfer
        // leg, funding account, split and override-split transfer accounts
        // (no moving money via a hidden account). So must a read that
        // answers a counterpart's own figures, which no mask hides
        // (@DelegateReadsEveryScheduledAccount).
        const readsEveryAccount =
          this.reflector.getAllAndOverride<boolean>(
            DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY,
            [context.getHandler(), context.getClass()],
          ) === true;
        const gated =
          operation === "read" && !readsEveryAccount
            ? accountIds.slice(0, 1)
            : accountIds;
        for (const accountId of gated) {
          // Reads keep the strict check (the primary account is always the
          // owner's); scheduled WRITES get the cross-owner relaxation so a
          // delegate can hold their own account as the other leg.
          if (operation === "read") {
            await this.assertPermission(
              payload.delegationId,
              accountId,
              operation,
            );
          } else {
            await this.assertTransferPermission(payload, accountId, operation);
          }
        }
      }
    }

    const capability = this.reflector.getAllAndOverride<DelegateCapabilityReq>(
      DELEGATE_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (capability) {
      const ok = await this.delegationService.hasCapability(
        payload.delegationId,
        capability.resource,
        capability.operation,
      );
      if (!ok) {
        const operation = capability.operation;
        const resource = RESOURCE_LABELS[capability.resource];
        throw new ForbiddenException(
          tr(
            "errors.delegation.capabilityNotGranted",
            `The account owner has not granted you permission to ${operation} ${resource}. Ask them to enable this in your delegated-access settings.`,
            { operation, resource },
          ),
        );
      }
    }

    const section = this.reflector.getAllAndOverride<DelegateSection>(
      DELEGATE_SECTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (section) {
      const ok = await this.delegationService.hasSection(
        payload.delegationId,
        section,
      );
      if (!ok) {
        const sectionLabel = SECTION_LABELS[section];
        throw new ForbiddenException(
          tr(
            "errors.delegation.sectionNotGranted",
            `The account owner has not shared the ${sectionLabel} section with you.`,
            { sectionLabel },
          ),
        );
      }
    }

    const fullScope = this.reflector.getAllAndOverride<boolean>(
      DELEGATE_FULL_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (fullScope) {
      const ok = await this.delegationService.grantsWholeLedger(
        payload.delegationId,
      );
      if (!ok) {
        throw new ForbiddenException(
          tr(
            "errors.delegation.fullScopeRequired",
            "The AI Assistant reads across all of the account owner's accounts and sections, so it is only available to a delegate who can read every account and every section. Ask the owner to share the rest with you, or use the pages you already have access to.",
          ),
        );
      }
    }

    return true;
  }

  /**
   * Cross-owner transfers: in the transfer and scheduled-write blocks an
   * account owned by the REAL user (payload.sub) passes without a grant row --
   * a delegate may name their own account as the other leg of a transfer. The
   * authoritative per-leg authorization lives in CrossOwnerAccessService at
   * the service layer; this guard stays as defense-in-depth for acting tokens.
   * @DelegatedAccountParam / @DelegatedTransactionParam are deliberately NOT
   * relaxed: a plain POST /transactions while acting writes owner-attributed
   * rows, so a delegate must never target their own account there.
   */
  private async assertTransferPermission(
    payload: any,
    accountId: string,
    operation: DelegateOperation,
  ): Promise<void> {
    if (await this.crossOwnerAccess.isAccountOwnedBy(accountId, payload.sub)) {
      return;
    }
    await this.assertPermission(payload.delegationId, accountId, operation);
  }

  private async assertPermission(
    delegationId: string,
    accountId: string,
    operation: DelegateOperation,
  ): Promise<void> {
    const ok = await this.delegationService.hasAccountPermission(
      delegationId,
      accountId,
      operation,
    );
    if (!ok) {
      throw new ForbiddenException(
        operation === "read"
          ? tr(
              "errors.delegation.accountNotShared",
              "The account owner has not shared this account with you.",
            )
          : tr(
              "errors.delegation.accountOperationNotGranted",
              `The account owner has not granted you permission to ${operation} transactions in this account.`,
              { operation },
            ),
      );
    }
  }

  private extractToken(req: Request): string | null {
    const header = req.headers?.authorization;
    if (header && header.startsWith("Bearer ")) {
      return header.slice(7);
    }
    const cookies = (req as Request & { cookies?: Record<string, string> })
      .cookies;
    if (cookies && cookies["auth_token"]) {
      return cookies["auth_token"];
    }
    return null;
  }

  private resolveAccountId(req: Request, key: string): string | undefined {
    const params = req.params as Record<string, unknown> | undefined;
    const body = req.body as Record<string, unknown> | undefined;
    const query = req.query as Record<string, unknown> | undefined;
    const candidate = params?.[key] ?? body?.[key] ?? (query?.[key] as unknown);
    return typeof candidate === "string" ? candidate : undefined;
  }
}
