import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney, sumMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import { AiActionBuilderService } from "../ai/actions/ai-action-builder.service";
import type { PendingAiAction } from "../ai/actions/ai-action.types";
import { TransactionsService } from "../transactions/transactions.service";
import { TransactionToolPrepService } from "../transactions/transaction-tool-prep.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { EmailReceipt } from "../email-receipts/entities/email-receipt.entity";
import { AiReviewRequest } from "./ai-review-request.entity";
import { AiReviewRequestsService } from "./ai-review-requests.service";
import {
  AI_REVIEW_EMAIL_TEXT_MAX_CHARS,
  AiReviewInboxItem,
  AiReviewProposalInput,
  AiReviewSubmitResult,
  DEFAULT_AI_REVIEW_TOOL_LIST_LIMIT,
  LlmAiReviewClaim,
  LlmAiReviewEmailReceipt,
  LlmAiReviewList,
  LlmAiReviewRequest,
  MAX_AI_REVIEW_TOOL_LIST_LIMIT,
  StoredAiReviewProposal,
} from "./ai-review-work.types";

/** Inbox page size when the caller names none, and its ceiling. */
export const DEFAULT_AI_REVIEW_INBOX_LIMIT = 50;

/** Statuses an inbox shows: everything still waiting, plus what ran out. */
const INBOX_STATUSES = ["pending", "claimed", "proposed", "expired"] as const;
const OPEN_STATUSES = ["pending", "claimed", "proposed"] as const;

interface AgentNote {
  reason: string;
  at: string;
}

function agentNoteOf(request: AiReviewRequest): AgentNote | undefined {
  const note = request.proposal?.agentNote as Partial<AgentNote> | undefined;
  return note && typeof note.reason === "string"
    ? { reason: note.reason, at: String(note.at ?? "") }
    : undefined;
}

/** The inbox's view of a stored email: who, what, when -- never its text. */
function inboxEmail(
  receipt: EmailReceipt | undefined,
): AiReviewInboxItem["emailReceipt"] {
  return receipt
    ? {
        id: receipt.id,
        fromAddress: receipt.fromAddress,
        subject: receipt.subject,
        receivedAt: receipt.receivedAt.toISOString(),
      }
    : null;
}

/**
 * The AI review queue as agents and people use it (design 6.5): the shared door
 * for the MCP `ai_review_requests` tool, the assistant's tool of the same name
 * and the review inbox's REST controller, so all three return one shape.
 *
 * A proposal is never a write. `submit` validates it with the same preparation
 * an `update_transaction` from the chat uses, stores the signed action on the
 * request and stops; the person approves through `/ai/actions/confirm`, which
 * marks the request applied in the transaction that writes the edit.
 */
@Injectable()
export class AiReviewWorkService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: AiReviewRequestsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @Inject(forwardRef(() => TransactionToolPrepService))
    private readonly prepService: TransactionToolPrepService,
    private readonly actionBuilder: AiActionBuilderService,
  ) {}

  private toLlm(request: AiReviewRequest, caller: string): LlmAiReviewRequest {
    const note = agentNoteOf(request);
    return {
      id: request.id,
      kind: request.kind,
      status: request.status,
      instruction: request.instruction,
      transactionId: request.transactionId,
      ruleId: request.ruleId,
      emailReceiptId: request.emailReceiptId ?? null,
      claimedByYou: request.claimedBy === caller,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
      ...(note ? { agentNote: note } : {}),
    };
  }

  /** Open requests that have not expired, oldest first. */
  async list(
    userId: string,
    caller: string,
    limit?: number,
  ): Promise<LlmAiReviewList> {
    const take = Math.min(
      Math.max(Math.trunc(limit ?? DEFAULT_AI_REVIEW_TOOL_LIST_LIMIT), 1),
      MAX_AI_REVIEW_TOOL_LIST_LIMIT,
    );
    // One more than asked, so `truncated` is a fact and not a guess.
    const rows = await this.requests.listForUser(userId, {
      statuses: OPEN_STATUSES,
      unexpiredOnly: true,
      limit: take + 1,
    });
    return {
      requests: rows.slice(0, take).map((r) => this.toLlm(r, caller)),
      totalCount: Math.min(rows.length, take),
      truncated: rows.length > take,
    };
  }

  /**
   * Take the oldest pending request (or the one named by `requestId`) for
   * `caller` and read its transaction
   * through the same projection `list_transactions` uses. A read that fails
   * after the claim gives the request back rather than stranding it.
   */
  async claim(
    userId: string,
    caller: string,
    requestId?: string,
  ): Promise<LlmAiReviewClaim> {
    // A named request is claimed by id (the receipts page hands the assistant
    // the request it just queued); none is the oldest pending one. A named
    // request that is not pending, expired or someone else's is "nothing".
    const request = requestId
      ? await this.requests.claimById(userId, requestId, caller)
      : await this.requests.claimNext(userId, caller);
    if (!request) return { request: null };
    try {
      const transaction = await this.transactionsService.getLlmTransactionById(
        userId,
        request.transactionId,
      );
      const emailReceipt = await this.loadEmailForClaim(userId, request);
      return {
        request: this.toLlm(request, caller),
        transaction,
        ...(emailReceipt ? { emailReceipt } : {}),
      };
    } catch (err) {
      await this.requests.release(userId, request.id, caller, {
        final: false,
        note: "The transaction or its email could not be read.",
      });
      throw err;
    }
  }

  /**
   * The email behind a request of kind `email_receipt`: who sent it, when, and
   * its text cut to `AI_REVIEW_EMAIL_TEXT_MAX_CHARS`. Read through the user's
   * own scope by id and owner, so another user's email is absent, never read.
   * Undefined for any other kind, and when the email was deleted since.
   */
  private async loadEmailForClaim(
    userId: string,
    request: AiReviewRequest,
  ): Promise<LlmAiReviewEmailReceipt | undefined> {
    if (request.kind !== "email_receipt" || !request.emailReceiptId) {
      return undefined;
    }
    const receipt = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(EmailReceipt).findOne({
        where: { id: request.emailReceiptId as string, userId },
        select: {
          id: true,
          fromAddress: true,
          subject: true,
          receivedAt: true,
          bodyText: true,
        },
      }),
    );
    if (!receipt) return undefined;
    return {
      fromAddress: receipt.fromAddress,
      subject: receipt.subject,
      receivedAt: receipt.receivedAt.toISOString(),
      text: receipt.bodyText.slice(0, AI_REVIEW_EMAIL_TEXT_MAX_CHARS),
    };
  }

  /** The claim check every agent write starts with; nothing is written before it passes. */
  private async requireClaim(
    userId: string,
    caller: string,
    requestId: string,
  ): Promise<AiReviewRequest> {
    const request = await this.requests.getForUser(userId, requestId);
    if (!request) {
      throw new NotFoundException(
        tr(
          "errors.aiReview.notFound",
          `AI review request with ID ${requestId} not found`,
          { id: requestId },
        ),
      );
    }
    if (request.status !== "claimed" || request.claimedBy !== caller) {
      throw new ConflictException(this.notClaimedMessage());
    }
    return request;
  }

  private notClaimedMessage(): string {
    return tr(
      "errors.aiReview.notClaimed",
      "This AI review request is not claimed by you. Claim the next pending one first; a request you did not claim cannot be answered.",
    );
  }

  /**
   * Build the confirmation card for `input` against the transaction as it is
   * now. Every refusal happens here, before anything is stored: an unusable
   * transfer, a proposal with no change, category lines that do not add up to
   * the transaction (the difference is named), an unknown category.
   */
  private async buildCard(
    userId: string,
    request: AiReviewRequest,
    input: AiReviewProposalInput,
  ): Promise<PendingAiAction> {
    if (
      input.splits === undefined &&
      input.categoryName === undefined &&
      input.payeeName === undefined &&
      input.description === undefined
    ) {
      throw new BadRequestException(
        tr(
          "errors.aiReview.nothingProposed",
          "A proposal needs at least one change: splits, categoryName, payeeName or description.",
        ),
      );
    }
    if (input.splits !== undefined && input.categoryName !== undefined) {
      throw new BadRequestException(
        tr(
          "errors.aiReview.splitsAndCategory",
          "Send either splits or categoryName, not both: a split transaction has no single category.",
        ),
      );
    }
    const transaction = await this.transactionsService.findOne(
      userId,
      request.transactionId,
    );
    if (transaction.isTransfer) {
      throw new BadRequestException(
        tr(
          "errors.aiReview.transferNotSupported",
          "A transfer cannot be reviewed by proposal. Reject the request instead.",
        ),
      );
    }
    if (input.splits !== undefined) {
      const amount = roundMoney(Number(transaction.amount));
      const sum = sumMoney(input.splits.map((line) => Number(line.amount)));
      if (sum !== amount) {
        throw new BadRequestException(
          tr(
            "errors.aiReview.splitDifference",
            `The split lines add up to ${sum} but the transaction is ${amount}: ${roundMoney(amount - sum)} is not assigned. Make the lines add up to the transaction; a leftover such as a delivery cost needs its own line, or is named to the user instead of being assigned.`,
            {
              sum,
              amount,
              difference: roundMoney(amount - sum),
            },
          ),
        );
      }
    }
    const prep = await this.prepService.prepareUpdate(userId, {
      transactionId: request.transactionId,
      splits: input.splits,
      categoryName: input.categoryName,
      payeeName: input.payeeName,
      description: input.description,
    });
    if (prep.kind !== "standard") {
      throw new BadRequestException(
        tr(
          "errors.aiReview.transferNotSupported",
          "A transfer cannot be reviewed by proposal. Reject the request instead.",
        ),
      );
    }
    return this.actionBuilder.buildUpdateTransaction(
      userId,
      prep.preview,
      prep.splits,
      undefined,
      { aiReviewRequestId: request.id },
    );
  }

  /**
   * Store an agent's proposal for the request it claimed and return the signed
   * card. The conditional UPDATE in `submitProposal` is the authority on the
   * claim; the read before it only refuses early and with a reason.
   */
  async submit(
    userId: string,
    caller: string,
    requestId: string,
    input: AiReviewProposalInput,
  ): Promise<AiReviewSubmitResult> {
    const request = await this.requireClaim(userId, caller, requestId);
    const action = await this.buildCard(userId, request, input);
    const stored: StoredAiReviewProposal = {
      input,
      action,
      proposedAt: new Date().toISOString(),
    };
    const proposed = await this.requests.submitProposal(
      userId,
      requestId,
      caller,
      stored as unknown as Record<string, unknown>,
    );
    if (!proposed) throw new ConflictException(this.notClaimedMessage());
    return { request: this.toLlm(proposed, caller), action };
  }

  /**
   * An agent gives a claimed request up. `cannotBeDone` closes it (`rejected`);
   * otherwise it returns to `pending` with the claim cleared, and the reason is
   * kept for the next agent.
   */
  async reject(
    userId: string,
    caller: string,
    requestId: string,
    reason: string,
    cannotBeDone: boolean,
  ): Promise<LlmAiReviewRequest> {
    await this.requireClaim(userId, caller, requestId);
    const released = await this.requests.release(userId, requestId, caller, {
      final: cannotBeDone,
      note: reason,
    });
    if (!released) throw new ConflictException(this.notClaimedMessage());
    return this.toLlm(released, caller);
  }

  // ---------------------------------------------------------------------
  // The review inbox (REST)
  // ---------------------------------------------------------------------

  /**
   * The user's requests, newest first, each with a summary of its transaction
   * and, when proposed, the card rebuilt against the transaction as it is now.
   */
  async listInbox(
    userId: string,
    options: { status?: AiReviewRequest["status"]; limit?: number } = {},
  ): Promise<AiReviewInboxItem[]> {
    const rows = await this.requests.listForUser(userId, {
      ...(options.status
        ? { status: options.status }
        : { statuses: INBOX_STATUSES }),
      limit: options.limit ?? DEFAULT_AI_REVIEW_INBOX_LIMIT,
      order: "DESC",
    });
    return this.toInboxItems(userId, rows);
  }

  private async toInboxItems(
    userId: string,
    rows: AiReviewRequest[],
  ): Promise<AiReviewInboxItem[]> {
    if (rows.length === 0) return [];

    const ruleIds = [
      ...new Set(rows.flatMap((r) => (r.ruleId ? [r.ruleId] : []))),
    ];
    const receiptIds = [
      ...new Set(
        rows.flatMap((r) => (r.emailReceiptId ? [r.emailReceiptId] : [])),
      ),
    ];
    const { transactions, rules, receipts } = await withScopedDb(
      this.dataSource,
      async (m) => ({
        transactions: await m.getRepository(Transaction).find({
          where: { userId, id: In(rows.map((r) => r.transactionId)) },
          relations: ["account", "category"],
        }),
        rules: ruleIds.length
          ? await m.getRepository(TransactionRule).find({
              where: { userId, id: In(ruleIds) },
              select: { id: true, name: true },
            })
          : [],
        receipts: receiptIds.length
          ? await m.getRepository(EmailReceipt).find({
              where: { userId, id: In(receiptIds) },
              select: {
                id: true,
                fromAddress: true,
                subject: true,
                receivedAt: true,
              },
            })
          : [],
      }),
    );
    const txById = new Map(transactions.map((t) => [t.id, t]));
    const ruleName = new Map(rules.map((r) => [r.id, r.name]));
    const receiptById = new Map(receipts.map((r) => [r.id, r]));

    const items: AiReviewInboxItem[] = [];
    for (const request of rows) {
      const t = txById.get(request.transactionId);
      const note = agentNoteOf(request);
      const stored = request.proposal as Partial<StoredAiReviewProposal> | null;
      items.push({
        id: request.id,
        kind: request.kind,
        status: request.status,
        instruction: request.instruction,
        transactionId: request.transactionId,
        ruleId: request.ruleId,
        ruleName: request.ruleId
          ? (ruleName.get(request.ruleId) ?? null)
          : null,
        emailReceipt: inboxEmail(
          request.emailReceiptId
            ? receiptById.get(request.emailReceiptId)
            : undefined,
        ),
        createdAt: request.createdAt.toISOString(),
        expiresAt: request.expiresAt.toISOString(),
        transaction: t
          ? {
              id: t.id,
              date: String(t.transactionDate).slice(0, 10),
              amount: Number(t.amount),
              currencyCode: t.currencyCode,
              payeeName: t.payeeName,
              description: t.description,
              accountId: t.accountId,
              accountName: t.account?.name ?? null,
              categoryName: t.category?.name ?? null,
              isSplit: t.isSplit,
            }
          : null,
        ...(note ? { agentNote: note } : {}),
        ...(request.status === "proposed" && stored?.input
          ? { proposal: await this.rebuiltCard(userId, request, stored.input) }
          : {}),
      });
    }
    return items;
  }

  private async rebuiltCard(
    userId: string,
    request: AiReviewRequest,
    input: AiReviewProposalInput,
  ): Promise<{ action: PendingAiAction } | { error: string }> {
    try {
      return { action: await this.buildCard(userId, request, input) };
    } catch (err) {
      // A refusal (the transaction changed and the lines no longer add up, a
      // category was deleted) is the reason to show. Anything else is ours and
      // propagates, so an internal error is never rendered as a proposal's.
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof ConflictException
      ) {
        return { error: err.message };
      }
      throw err;
    }
  }

  /** The person dismisses a request that is still open. */
  async dismiss(userId: string, requestId: string): Promise<AiReviewInboxItem> {
    const dismissed = await this.requests.dismiss(userId, requestId);
    if (!dismissed) {
      const existing = await this.requests.getForUser(userId, requestId);
      if (!existing) {
        throw new NotFoundException(
          tr(
            "errors.aiReview.notFound",
            `AI review request with ID ${requestId} not found`,
            { id: requestId },
          ),
        );
      }
      throw new ConflictException(
        tr(
          "errors.aiReview.notOpen",
          "This AI review request is no longer open.",
        ),
      );
    }
    const [item] = await this.toInboxItems(userId, [dismissed]);
    return item;
  }
}
