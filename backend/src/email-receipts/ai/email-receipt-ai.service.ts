import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { AiService } from "../../ai/ai.service";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { EMAIL_RECEIPTS_AI_CLAIM_KEY } from "../../ai-review/ai-review-work.types";
import { loadQualifiedCategoryNames } from "../../categories/category-name.util";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { TransactionsService } from "../../transactions/transactions.service";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  describeFailure,
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CHAT_INSTRUCTION,
} from "../pipeline/email-receipt-pipeline.service";
import { loadLinkableTransaction } from "../pipeline/linkable-transaction";
import {
  closeReceiptRequests,
  currentReceiptRequestStatus,
  lockReceiptTransaction,
} from "../pipeline/receipt-requests.util";
import {
  collectParserCategoryIds,
  validateReceiptParserDefinition,
} from "../parsing/receipt-parser.validation";
import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import {
  buildDescription,
  buildReceiptProposal,
  type ReceiptProposalReason,
} from "../proposal/build-receipt-proposal";
import { MAX_PARSERS_PER_USER } from "../parsers/email-receipt-parsers.service";
import {
  toParserView,
  type EmailReceiptParserView,
} from "../parsers/email-receipt-parser.view";
import {
  assertParserReferencesOwned,
  describeValidationErrors,
} from "../parsers/parser-references.util";
import { isReceiptDomain } from "../parsers/dto/receipt-domain.validator";
import {
  buildParserDraftUserContent,
  buildReceiptReviewUserContent,
  PARSER_DRAFT_SYSTEM_PROMPT,
  RECEIPT_REVIEW_SYSTEM_PROMPT,
} from "./email-receipt-ai.prompts";
import { buildAiParsedReceipt } from "./email-receipt-ai.extraction";
import { extractJsonObject } from "./email-receipt-ai.schema";

/** The `feature` labels the provider usage log records (design section 8). */
export const EMAIL_RECEIPT_PARSER_FEATURE = "email_receipt_parser";
export const EMAIL_RECEIPT_REVIEW_FEATURE = "email_receipt_review";

const DRAFT_MAX_TOKENS = 4096;
const REVIEW_MAX_TOKENS = 4096;
const MAX_NOTE = 300;

/** Why a request was not answered, as a code the receipts page can name. */
export type EmailReceiptAiFailure =
  | "ai_off"
  | "not_a_receipt_request"
  | "receipt_missing"
  | "not_claimable"
  | "transaction_unreadable"
  | "ai_unavailable"
  | "unusable_answer"
  | "proposal_refused"
  | "request_failed";

export type AiRequestOutcome =
  | { ok: true; requestId: string }
  | { ok: false; requestId: string; reason: EmailReceiptAiFailure };

/**
 * What `askAi` answers once the request is stored: the request that waits,
 * `pending`, in the AI review inbox, and the transaction it is about. Nothing
 * has answered it yet: the assistant in the chat (or an MCP agent) claims it by
 * id and submits the proposal.
 */
export interface AskAiResult {
  ok: true;
  requestId: string;
  transactionId: string;
}

/** What the automatic step of one poll did. */
export interface AutomaticAiStepResult {
  /** Requests the AI answered (proposed). */
  proposed: number;
  /** Requests it could not answer (released for an agent or a person). */
  failed: number;
  /** Parser drafts created. */
  drafted: number;
}

/** Operator-fixed bounds of the automatic step, per user per poll (design 3.6). */
export const AUTOMATIC_AI_CALLS_PER_TICK = 5;
export const AUTOMATIC_DRAFTS_PER_TICK = 2;

interface ReceiptContext {
  receipt: EmailReceipt;
  aiMode: EmailReceiptMailbox["aiMode"];
}

/**
 * The AI's two jobs on email receipts (design sections 3.6, 5 and 8), both
 * through `AiService.complete` with a JSON reply:
 *
 * - `draftParser`: a DRAFT parser from one sample email. The draft passes the
 *   same validator a person's parser passes, and starts `draft`: it reads
 *   nothing until a person approves it.
 * - `processAiRequest`: a PROPOSAL for a receipt's request. The model reads the
 *   email's content (products, prices, total), not a split: its answer becomes a
 *   `ParsedReceipt` (`source: "ai"`), is judged by the parser's completeness
 *   rules, turned into a proposal by `buildReceiptProposal` (the code a parser's
 *   proposal goes through) and submitted through `AiReviewWorkService.submit`
 *   exactly as an agent's is, so the amounts, the categories and the transfer
 *   refusal are checked by the same code. It is never applied here: a person
 *   approves the card.
 *
 * AI mode governs only what happens by itself: the poll's automatic step
 * (`runAutomaticStep`, bounded) calls `AiService` for `automatic` mailboxes
 * alone. Pressing "Recognize with AI" (`askAi`) is the person's own consent,
 * whatever the mode, and calls no provider: it queues the request and the
 * assistant in the chat answers it by id.
 * `draftParser` keeps its own rule and is refused in mode `off`. The email text
 * is data in every prompt (`email-receipt-ai.prompts.ts`).
 */
@Injectable()
export class EmailReceiptAiService {
  private readonly logger = new Logger(EmailReceiptAiService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
    private readonly requests: AiReviewRequestsService,
    private readonly work: AiReviewWorkService,
    private readonly transactions: TransactionsService,
  ) {}

  // ---------------------------------------------------------------------
  // Draft a parser
  // ---------------------------------------------------------------------

  /**
   * Draft a parser for the sender of one stored email. Refused (400) when the
   * mailbox's AI mode is `off`. The reply is validated with
   * `validateReceiptParserDefinition` and every category id it names must be one
   * the user owns; an answer that fails either is a 422 naming the codes. The
   * parser is created `draft`, source `ai`, for the email's sender domain.
   */
  async draftParser(
    userId: string,
    receiptId: string,
  ): Promise<EmailReceiptParserView> {
    const { receipt } = await this.readContext(userId, receiptId, {
      requireAi: true,
    });
    if (!isReceiptDomain(receipt.fromDomain)) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.receiptNoSender",
          "This email has no usable sender domain, so a parser cannot be drafted for it.",
        ),
      );
    }
    const categories = await withScopedDb(this.dataSource, (m) =>
      loadQualifiedCategoryNames(m, userId),
    );

    const reply = await this.ai.complete(
      userId,
      {
        systemPrompt: PARSER_DRAFT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildParserDraftUserContent({
              domain: receipt.fromDomain,
              subject: receipt.subject,
              bodyText: receipt.bodyText,
              categories,
            }),
          },
        ],
        maxTokens: DRAFT_MAX_TOKENS,
        temperature: 0.1,
        responseFormat: "json",
      },
      EMAIL_RECEIPT_PARSER_FEATURE,
    );

    const raw = extractJsonObject(reply.content);
    if (raw === undefined) {
      throw new UnprocessableEntityException(
        tr(
          "errors.emailReceipts.aiDraftUnreadable",
          "The AI's answer was not a parser. Try again, or write the parser by hand.",
        ),
      );
    }
    // A model that leaves the version out has still written a version 1 parser.
    const candidate =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? { version: 1, ...raw }
        : raw;
    const validation = validateReceiptParserDefinition(candidate);
    if (!validation.ok) {
      const codes = describeValidationErrors(validation.errors);
      throw new UnprocessableEntityException(
        tr(
          "errors.emailReceipts.aiDraftInvalid",
          `The AI's parser was not valid (${codes}). Try again, or write the parser by hand.`,
          { codes },
        ),
      );
    }
    const definition = validation.definition;
    const categoryIds = collectParserCategoryIds(definition);
    if (categoryIds.some((id) => !categories.has(id))) {
      throw new UnprocessableEntityException(
        tr(
          "errors.emailReceipts.aiDraftUnknownCategory",
          "The AI's parser named a category that does not exist. Try again, or write the parser by hand.",
        ),
      );
    }

    const created = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      const stillThere = await m
        .getRepository(EmailReceipt)
        .count({ where: { id: receiptId, userId } });
      if (stillThere === 0) throw receiptNotFound(receiptId);
      if ((await repo.count({ where: { userId } })) >= MAX_PARSERS_PER_USER) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.tooManyParsers",
            `At most ${MAX_PARSERS_PER_USER} parsers can be saved. Delete one first.`,
            { max: MAX_PARSERS_PER_USER },
          ),
        );
      }
      await assertParserReferencesOwned(m, userId, {
        payeeId: null,
        categoryIds,
      });
      return repo.save(
        repo.create({
          userId,
          name: receipt.fromDomain.slice(0, 100),
          payeeId: null,
          fromDomains: [receipt.fromDomain],
          subjectContains: [],
          definition: definition as unknown as Record<string, unknown>,
          status: "draft",
          source: "ai",
          approvedAt: null,
        }),
      );
    });
    return toParserView(created);
  }

  // ---------------------------------------------------------------------
  // Propose for a receipt's request
  // ---------------------------------------------------------------------

  /**
   * "Recognize with AI" on one receipt, optionally for a transaction the person
   * chose. ONE transaction holds every check and every write, in the lock order
   * of this module (the receipt row, the advisory lock the enqueue takes, the
   * request rows): refuse an ignored or skipped email and an applied proposal
   * (409), check the chosen transaction with the predicate "link" uses and store
   * it as `manual`, refuse (400) an email that still has no transaction, dismiss
   * the email's own open request, queue a `pending` one (a null from the queue
   * is another open request on the transaction: 409) and point the receipt at it
   * in state `review`. A rejection has written nothing.
   *
   * No provider is called here. The request waits pending for whoever claims it
   * by id: the assistant in the chat, which the receipts page opens with the
   * email attached, or an MCP agent.
   */
  async askAi(
    userId: string,
    receiptId: string,
    transactionId?: string | null,
  ): Promise<AskAiResult> {
    return withScopedDb(this.dataSource, async (m) => {
      const receipt = await m.getRepository(EmailReceipt).findOne({
        where: { id: receiptId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!receipt) throw receiptNotFound(receiptId);
      if (receipt.status === "skipped" || receipt.status === "ignored") {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptNotAskable",
            "This email was ignored or could not be read. Reprocess it first.",
          ),
        );
      }
      const current = await currentReceiptRequestStatus(
        m,
        userId,
        receipt.aiReviewRequestId,
      );
      if (current === "applied") {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptApplied",
            "This email's proposal has already been applied to a transaction.",
          ),
        );
      }
      const chosen = transactionId
        ? await loadLinkableTransaction(m, userId, transactionId)
        : null;
      const target = chosen?.id ?? receipt.transactionId;
      if (target === null) {
        throw new BadRequestException(
          tr(
            "errors.emailReceipts.receiptNeedsTransaction",
            "Choose the transaction this email paid for before asking the AI about it.",
          ),
        );
      }
      await lockReceiptTransaction(m, target);
      await closeReceiptRequests(m, userId, receipt.id);
      const created = await this.requests.enqueuePendingForReceipt(m, userId, {
        transactionId: target,
        emailReceiptId: receipt.id,
        instruction: RECEIPT_CHAT_INSTRUCTION,
      });
      if (!created) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.openRequestExists",
            "Another review request is already open for this transaction. Finish or dismiss it first.",
          ),
        );
      }
      await m.getRepository(EmailReceipt).update(
        { id: receipt.id, userId },
        {
          status: "review",
          statusReason: null,
          aiReviewRequestId: created.id,
          ...(chosen
            ? {
                transactionId: chosen.id,
                matchKind: "manual" as const,
                candidateTransactionIds: [],
              }
            : {}),
        },
      );
      return {
        ok: true as const,
        requestId: created.id,
        transactionId: target,
      };
    });
  }

  /**
   * Answer one receipt request with the AI: claim it under the AI's own key,
   * read the transaction, the email and the category names, ask for JSON, check
   * its shape, and submit it like an agent. Any failure gives the claim back
   * (`final: false`, with a short note) so an MCP agent or the assistant may
   * take it, and is returned as the reason. Nothing here applies anything.
   */
  async processAiRequest(
    userId: string,
    requestId: string,
  ): Promise<AiRequestOutcome> {
    const fail = (reason: EmailReceiptAiFailure): AiRequestOutcome => ({
      ok: false,
      requestId,
      reason,
    });

    const request = await this.requests.getForUser(userId, requestId);
    if (
      !request ||
      request.kind !== "email_receipt" ||
      !request.emailReceiptId
    ) {
      return fail("not_a_receipt_request");
    }
    const found = await this.tryReadContext(userId, request.emailReceiptId);
    if (!found) return fail("receipt_missing");
    // Before the claim and before any provider call: `off` never reaches the AI.
    if (found.aiMode === "off") return fail("ai_off");

    const claimed = await this.requests.claimById(
      userId,
      requestId,
      EMAIL_RECEIPTS_AI_CLAIM_KEY,
    );
    if (!claimed) return fail("not_claimable");

    const giveBack = async (
      reason: EmailReceiptAiFailure,
      note: string,
    ): Promise<AiRequestOutcome> => {
      try {
        await this.requests.release(
          userId,
          requestId,
          EMAIL_RECEIPTS_AI_CLAIM_KEY,
          {
            final: false,
            note: note.slice(0, MAX_NOTE),
          },
        );
      } catch (error) {
        this.logger.warn(
          `Could not give back receipt request ${requestId} (${describeFailure(error)})`,
        );
      }
      return fail(reason);
    };

    try {
      const transaction = await this.transactions.findOne(
        userId,
        claimed.transactionId,
      );
      if (transaction.isTransfer) {
        return giveBack(
          "transaction_unreadable",
          "A transfer cannot be reviewed by proposal.",
        );
      }
      const categories = await withScopedDb(this.dataSource, (m) =>
        loadQualifiedCategoryNames(m, userId),
      );

      let content: string;
      try {
        const reply = await this.ai.complete(
          userId,
          {
            systemPrompt: RECEIPT_REVIEW_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildReceiptReviewUserContent({
                  subject: found.receipt.subject,
                  bodyText: found.receipt.bodyText,
                  categories,
                  transaction: {
                    amount: Number(transaction.amount),
                    currencyCode: transaction.currencyCode,
                    date: String(transaction.transactionDate).slice(0, 10),
                    payeeName: transaction.payeeName,
                    description: transaction.description,
                  },
                }),
              },
            ],
            maxTokens: REVIEW_MAX_TOKENS,
            temperature: 0.1,
            responseFormat: "json",
          },
          EMAIL_RECEIPT_REVIEW_FEATURE,
        );
        content = reply.content;
      } catch (error) {
        this.logger.warn(
          `AI review of receipt request ${requestId} failed (${describeFailure(error)})`,
        );
        return giveBack("ai_unavailable", "The AI provider did not answer.");
      }

      const extraction = buildAiParsedReceipt(content, categories);
      if (!extraction.ok) return giveBack("unusable_answer", extraction.note);
      const { parsed, description, notes } = extraction;
      if (notes.length > 0) {
        this.logger.warn(
          `AI reading of receipt request ${requestId}: ${notes.join(" ")}`,
        );
      }
      if (parsed.items.length === 0 && parsed.total === null && !description) {
        return giveBack(
          "unusable_answer",
          `The AI found nothing in the email. ${notes.join(" ")}`.trim(),
        );
      }

      // The same proposal a parser's reading goes through. With no item to name,
      // the AI's own summary is the description (the parser summary would be the
      // sender alone).
      const proposal = buildReceiptProposal(
        parsed,
        {
          amount: Number(transaction.amount),
          description: transaction.description,
          payeeId: transaction.payeeId ?? null,
        },
        {
          parserName: found.receipt.fromDomain || "Email",
          payeeName: null,
          categoryNames: categories,
        },
      );
      let input = proposal.input;
      if (parsed.items.length === 0 && description !== null) {
        const composed = buildDescription(transaction.description, description);
        if (composed !== null)
          input = { ...(input ?? {}), description: composed };
      }
      if (input === null) {
        return giveBack(
          "unusable_answer",
          "The AI proposed nothing to change.",
        );
      }

      await this.storeReading(
        userId,
        found.receipt.id,
        requestId,
        parsed,
        proposal.reason,
      );
      try {
        await this.work.submit(
          userId,
          EMAIL_RECEIPTS_AI_CLAIM_KEY,
          requestId,
          input,
        );
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return giveBack("proposal_refused", error.message);
      }
      return { ok: true, requestId };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return giveBack(
          "transaction_unreadable",
          "The transaction could not be read.",
        );
      }
      this.logger.warn(
        `Receipt request ${requestId} could not be answered (${describeFailure(error)})`,
      );
      return giveBack("request_failed", "The AI request failed.");
    }
  }

  /**
   * What the AI read, stored on the email (`parsed`, marked `source: "ai"`) with
   * the reason the proposal is not itemized, so the email page shows both. One
   * conditional UPDATE: only while the email still points at this request, so a
   * reprocess or another "Recognize with AI" that replaced it is not overwritten
   * by a slow answer.
   */
  private async storeReading(
    userId: string,
    receiptId: string,
    requestId: string,
    parsed: ParsedReceipt,
    reason: ReceiptProposalReason | null,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE email_receipts
            SET parsed = $4::jsonb,
                status_reason = $5
          WHERE id = $1
            AND user_id = $2
            AND ai_review_request_id = $3`,
        [receiptId, userId, requestId, JSON.stringify(parsed), reason],
      ),
    );
  }

  // ---------------------------------------------------------------------
  // The poll's automatic step
  // ---------------------------------------------------------------------

  /**
   * What the poll does for a mailbox in mode `automatic`, bounded per user per
   * tick: first up to `AUTOMATIC_DRAFTS_PER_TICK` parser drafts (one per sender
   * domain that has no parser at all, draft or approved, and whose last draft
   * did not fail), then up to the rest of `AUTOMATIC_AI_CALLS_PER_TICK` pending
   * receipt requests nobody has claimed or tried. A request or a draft that
   * fails is not retried by the poll: a released request carries a note, and a
   * failed draft marks its email `draft_failed` until it is reprocessed.
   */
  async runAutomaticStep(userId: string): Promise<AutomaticAiStepResult> {
    const result: AutomaticAiStepResult = {
      proposed: 0,
      failed: 0,
      drafted: 0,
    };
    let budget = AUTOMATIC_AI_CALLS_PER_TICK;

    const drafts = await this.receiptsNeedingDraft(
      userId,
      Math.min(AUTOMATIC_DRAFTS_PER_TICK, budget),
    );
    for (const receiptId of drafts) {
      budget--;
      try {
        await this.draftParser(userId, receiptId);
        result.drafted++;
      } catch (error) {
        this.logger.warn(
          `Automatic parser draft failed (${describeFailure(error)})`,
        );
        await this.markDraftFailed(userId, receiptId);
      }
    }

    for (const requestId of await this.pendingRequests(userId, budget)) {
      const outcome = await this.processAiRequest(userId, requestId);
      if (outcome.ok) result.proposed++;
      else result.failed++;
    }
    return result;
  }

  /** One receipt per sender domain that no parser of the user covers and no draft failed for. */
  private async receiptsNeedingDraft(
    userId: string,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT id FROM (
             SELECT DISTINCT ON (r.from_domain) r.id, r.from_domain, r.received_at
               FROM email_receipts r
              WHERE r.user_id = $1
                AND r.status = 'no_parser'
                AND r.from_domain <> ''
                AND NOT EXISTS (
                      SELECT 1
                        FROM email_receipt_parsers p,
                             unnest(p.from_domains) AS d(domain)
                       WHERE p.user_id = r.user_id
                         AND (r.from_domain = d.domain
                              OR right(r.from_domain, length(d.domain) + 1)
                                 = '.' || d.domain))
                AND NOT EXISTS (
                      SELECT 1
                        FROM email_receipts failed
                       WHERE failed.user_id = r.user_id
                         AND failed.from_domain = r.from_domain
                         AND failed.status_reason = 'draft_failed')
              ORDER BY r.from_domain, r.received_at DESC, r.id
           ) one_per_domain
           ORDER BY received_at DESC, id
           LIMIT $2`,
          [userId, limit],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }

  private async markDraftFailed(
    userId: string,
    receiptId: string,
  ): Promise<void> {
    try {
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `UPDATE email_receipts
              SET status_reason = 'draft_failed'
            WHERE id = $1
              AND user_id = $2
              AND status = 'no_parser'`,
          [receiptId, userId],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark a failed draft (${describeFailure(error)})`,
      );
    }
  }

  /**
   * Pending receipt requests nobody claimed and no agent has already given up
   * on, that the POLL queued (its own instruction). A request the person made with
   * "Recognize with AI" carries `RECEIPT_CHAT_INSTRUCTION` and belongs to the
   * chat or an MCP agent: the automatic step never takes it.
   */
  private async pendingRequests(
    userId: string,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT id
             FROM ai_review_requests
            WHERE user_id = $1
              AND kind = 'email_receipt'
              AND status = 'pending'
              AND claimed_by IS NULL
              AND proposal IS NULL
              AND expires_at > CURRENT_TIMESTAMP
              AND instruction = $3
            ORDER BY created_at, id
            LIMIT $2`,
          [userId, limit, RECEIPT_AUTOMATIC_AI_INSTRUCTION],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }

  // ---------------------------------------------------------------------

  private async readContext(
    userId: string,
    receiptId: string,
    options: { requireAi: boolean },
  ): Promise<ReceiptContext> {
    const found = await this.tryReadContext(userId, receiptId);
    if (!found) throw receiptNotFound(receiptId);
    if (options.requireAi && found.aiMode === "off") throw aiOff();
    return found;
  }

  private tryReadContext(
    userId: string,
    receiptId: string,
  ): Promise<ReceiptContext | null> {
    return withScopedDb(this.dataSource, async (m: EntityManager) => {
      const receipt = await m
        .getRepository(EmailReceipt)
        .findOne({ where: { id: receiptId, userId } });
      if (!receipt) return null;
      const mailbox = await m
        .getRepository(EmailReceiptMailbox)
        .findOne({ where: { id: receipt.mailboxId, userId } });
      return { receipt, aiMode: mailbox?.aiMode ?? "off" };
    });
  }
}

function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}

function aiOff(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.emailReceipts.aiOff",
      "The AI is turned off for this mailbox. Change the AI mode in the mailbox settings first.",
    ),
  );
}
