import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request } from "express";
import { Observable, from, switchMap } from "rxjs";
import { map } from "rxjs/operators";
import { DelegationService } from "../delegation.service";

const HIDDEN = "Hidden account";

/**
 * 2B: when a delegate (acting as owner) reads transactions, any transfer
 * whose counterpart account they lack READ on must be masked so the other
 * side shows "Hidden account" instead of the real account/name.
 *
 * Runs after the route handler, so req.user is populated by JwtStrategy.
 * Non-delegate requests pass straight through.
 */
@Injectable()
export class DelegateTransferMaskInterceptor implements NestInterceptor {
  constructor(private readonly delegationService: DelegationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: { isActing?: boolean; delegationId?: string } }
      >();
    const user = req.user;
    if (!user?.isActing || !user.delegationId) {
      return next.handle();
    }
    const delegationId = user.delegationId;

    return next.handle().pipe(
      switchMap((body) =>
        from(this.delegationService.readableAccountIds(delegationId)).pipe(
          map((readableIds) => {
            const readable = new Set(readableIds);
            this.maskPayload(body, readable);
            return body;
          }),
        ),
      ),
    );
  }

  private maskPayload(body: unknown, readable: Set<string>): void {
    if (Array.isArray(body)) {
      body.forEach((t) => this.maskTransaction(t, readable));
      return;
    }
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (Array.isArray(obj.data)) {
        (obj.data as unknown[]).forEach((t) =>
          this.maskTransaction(t, readable),
        );
        return;
      }
      this.maskTransaction(body, readable);
    }
  }

  private maskTransaction(tx: unknown, readable: Set<string>): void {
    if (!tx || typeof tx !== "object") return;
    const t = tx as Record<string, any>;
    const linked = t.linkedTransaction as Record<string, any> | undefined;
    if (!t.isTransfer || !linked) return;
    const otherAccountId: string | undefined = linked.accountId;
    if (!otherAccountId || readable.has(otherAccountId)) return;

    if (linked.account && typeof linked.account === "object") {
      linked.account = { id: linked.accountId, name: HIDDEN };
    }
    if (typeof linked.accountName === "string") {
      linked.accountName = HIDDEN;
    }
    // The visible row's auto payee name embeds the counterpart account name
    // ("Transfer to/from <name>") -- rewrite the trailing name.
    if (typeof t.payeeName === "string") {
      const m = /^(Transfer (?:to|from) ).+/.exec(t.payeeName);
      if (m) t.payeeName = `${m[1]}${HIDDEN}`;
    }
  }
}
