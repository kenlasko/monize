import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { categoryIdForCategoryRow } from "../../categories/category-row-gate";
import { DataSource, EntityManager, QueryDeepPartialEntity } from "typeorm";
import { AiActionsService } from "../../ai/actions/ai-actions.service";
import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import {
  AiReviewProposalInput,
  EMAIL_RECEIPTS_CLAIM_KEY,
} from "../../ai-review/ai-review-work.types";
import { loadQualifiedCategoryNames } from "../../categories/category-name.util";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { Payee } from "../../payees/entities/payee.entity";
import { PayeesService } from "../../payees/payees.service";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import {
  EmailReceiptMailbox,
  type EmailReceiptAiMode,
} from "../entities/email-receipt-mailbox.entity";
import {
  EmailReceipt,
  type EmailReceiptMatchKind,
  type EmailReceiptStatus,
} from "../entities/email-receipt.entity";
import {
  effectiveReceiptDate,
  isForwardedReceipt,
  mayBeForwarded,
  resolveForwardedIdentity,
  sameIdentity,
  type ReceiptIdentity,
} from "../imap/forwarded-receipt";
import { loadOwnAddresses } from "../poll/own-addresses";
import {
  EmailReceiptCategoryAiService,
  type CategoryQuestionItem,
} from "../ai/email-receipt-category-ai.service";
import { matchReceipt } from "../matching/match-receipt";
import { completeness, parseReceiptLines } from "../parsing/parse-receipt";
import { resolveMatchConfig } from "../parsing/receipt-match-config";
import {
  isItemLine,
  type ParsedReceipt,
  type ReceiptLinkOutcome,
  type ReceiptLinkReport,
  type ParsedTrade,
} from "../parsing/receipt-parser.types";
import { componentReason } from "../linking/component-reason";
import { loadLinkedComponents } from "../linking/component-lookup";
import { waitingSettlements } from "../linking/waiting-settlements";
import {
  componentNet,
  hasJoinedPart,
  joinSettlement,
  type JoinedSettlement,
} from "../linking/join-settlement";
import {
  linkRowsOf,
  replaceLinkRows,
  type LinkRowInput,
} from "../linking/link-rows";
import {
  applyCategoryHistory,
  loadItemCategoryHistory,
} from "../proposal/receipt-category-history";
import {
  buildReceiptProposal,
  type ReceiptProposal,
  type ReceiptProposalContext,
  type ReceiptProposalTransaction,
} from "../proposal/build-receipt-proposal";
import { autoApplyAllowed, type AutoApplyFacts } from "./auto-apply-gate";
import {
  EmailReceiptTradeService,
  RECEIPT_TRADE_EXISTS_REASON,
} from "./email-receipt-trade.service";
import { deleteLockedReceipt } from "../receipts/receipt-disposal";
import { loadApprovedParsers } from "./approved-parsers";
import {
  chooseReceiptParser,
  type ReceiptParserChoice,
} from "./choose-receipt-parser";
import { describeFailure, isRefusal, refusalNote } from "./receipt-failure";
import { loadLinkableTransaction } from "./linkable-transaction";
import { loadReceiptCandidates } from "./receipt-candidates";
import { ReceiptSourceLines } from "./receipt-source-lines";
import { readSchemaOrgReceipt } from "./schema-org-reading";
import {
  closeReceiptRequests,
  currentReceiptRequest,
  lockReceiptTransaction,
} from "./receipt-requests.util";

import {
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CATEGORIZE_INSTRUCTION,
  RECEIPT_PARSED_INSTRUCTION,
} from "./receipt-instructions";

/**
 * The `status_reason` of a receipt a parser's `skipIfLine` set aside (`ignored`)
 * and of one its `waitIfLine` holds back (`unmatched`, read again by the poll's
 * rematch while it is recent). `status_reason` is free text of up to 40
 * characters (no CHECK), so neither needs a migration.
 */
export const RECEIPT_SKIP_LINE_REASON = "skip_line";
export const RECEIPT_WAIT_LINE_REASON = "wait_line";
/** The `ignored` reason of an email whose profile ignores every email it matches (`discard: "ignore"`). */
export const RECEIPT_PROFILE_IGNORE_REASON = "profile_ignore";
/**
 * The `status_reason` of a `parse_failed` receipt whose parser reads the HTML
 * part (`source: "html"`) when the email stored none.
 */
export const RECEIPT_NO_HTML_REASON = "no_html";
/**
 * The `status_reason` of a receipt read from the email's own schema.org order
 * (`ParsedReceipt.source` `"schema_org"`). It fills the reason slot only when
 * the outcome has no more specific reason of its own (`amount_differs`,
 * `items_uncategorized`, ...), which `parsed.source` records either way.
 */
export const RECEIPT_SCHEMA_ORG_REASON = "schema_org";
/** The `parse_failed` reason of a component email that holds no link value (linked receipts spec 2.1). */
export const RECEIPT_NO_LINK_KEY_REASON = "no_link_key";
/** The reason of a settlement some linked part of which stayed one line (spec 4.4 and 12). */
export const RECEIPT_PARTIALLY_LINKED_REASON = "partially_linked";
/** The `review_conflict` reason of a settlement whose transaction another email enriched (spec 6). */
export const RECEIPT_ENRICHED_BY_OTHER_REASON = "enriched_by_other";

/** What `process` does and refuses, by who asked. */
export interface ProcessReceiptOptions {
  /**
   * The poll's guard: act only while the locked row is in one of these statuses,
   * and leave it alone (`unchanged`) otherwise, so a person's "ignore" or
   * "link" that landed first is never undone by a tick that selected the row
   * earlier.
   */
  readonly onlyWhenStatusIn?: readonly EmailReceiptStatus[];
  /** A person names the transaction (match kind `manual`); nothing is matched. */
  readonly link?: { readonly transactionId: string };
  /**
   * The categories the AI chose for the items a profile's rules left
   * uncategorized (design 5.6). Decided by `process` itself: `undefined` on the
   * first pass (a profile with `aiCategories` that needs them hands back what to
   * ask, writing nothing), an array once the AI answered, `null` when it could not
   * be asked or did not answer (the items stay uncategorized and the request is
   * queued for an agent).
   */
  readonly categoryHints?: readonly CategoryHint[] | null;
  /**
   * How many AI category questions this run may still ask (the poll's tick, a
   * bulk run): shared and decremented by `process`. With none left the question
   * is not asked and the request is queued for an agent. Absent: unbounded (a
   * person pressed the button for one email).
   */
  readonly aiCategoryBudget?: { remaining: number };
  /**
   * Internal, set by the re-join of linked receipts spec 8: read a settlement
   * whose request was applied again against its own transaction (no new match),
   * and propose a new card only when a part now joins that did not. Anything
   * else leaves the row as it is.
   */
  readonly rejoin?: boolean;
}

/** The most settlements one component re-joins after it is stored (linked receipts spec 8). */
export const MAX_REJOINED_SETTLEMENTS = 20;

/** The statuses an ordinary reprocess of a settlement that waits for a component may start from. */
const REJOIN_REPROCESS_STATUSES = [
  "unmatched",
  "ambiguous",
  "review",
  "review_conflict",
  "parse_failed",
] as const satisfies readonly EmailReceiptStatus[];

/** A category the AI chose for item `index` of a reading; `name` guards against a reading that changed since. */
export interface CategoryHint {
  readonly index: number;
  readonly name: string;
  readonly categoryId: string;
}

export interface ProcessReceiptResult {
  status: EmailReceiptStatus;
  statusReason: string | null;
  transactionId: string | null;
  matchKind: EmailReceiptMatchKind | null;
  requestId: string | null;
  /** The approved proposal was applied through `confirm` (spec section 7). */
  autoApplied: boolean;
  /** The row was left as it was (see `onlyWhenStatusIn`). */
  unchanged: boolean;
  /** The row is gone: its profile deletes every email it matches (`discard: "delete"`). */
  deleted: boolean;
}

// The gate of spec section 7 lives in its own file; re-exported for its callers.
export { autoApplyAllowed, type AutoApplyFacts };

interface Stored {
  status: EmailReceiptStatus;
  reason: string | null;
  parserId: string | null;
  parsed: ParsedReceipt | null;
  /** A trade profile's reading; absent (stored as null) for every other email. */
  trade?: ParsedTrade | null;
  /** The ledger row a trade email accounts for; absent (stored as null) otherwise. */
  investmentTransactionId?: string | null;
  transactionId: string | null;
  candidateIds: string[];
  matchKind: EmailReceiptMatchKind | null;
  requestId: string | null;
  /** A `component` receipt's link value; every other outcome stores null. */
  linkKey?: string | null;
  /** The link rows of a settlement after the join; absent leaves it with none. */
  links?: LinkRowInput[];
  /** What the joined components now hold; written with the settlement, never on a pass that writes nothing. */
  componentReasons?: JoinedSettlement["componentReasons"];
}

interface TransactionFacts extends ReceiptProposalTransaction {
  id: string;
}

interface Committed {
  result: ProcessReceiptResult;
  /** Present when the gate of spec section 7 passed: the signed card to confirm. */
  autoApply: PendingAiAction | null;
  /**
   * Present when a profile that wants the AI's categories matched a transaction
   * and items are still uncategorized: nothing has been written (design 5.6), the
   * caller asks and runs the transaction again with `categoryHints`.
   */
  needsCategories?: {
    aiMode: EmailReceiptAiMode;
    items: CategoryQuestionItem[];
    categories: ReadonlyMap<string, string>;
  };
  /**
   * Present when a component was stored: the settlements (newest first, at most
   * `MAX_REJOINED_SETTLEMENTS`) that wait for its link value. `process` reads
   * each again after the commit; a settlement's own pass never sets it.
   */
  rejoin?: string[];
}

export { describeFailure };

/**
 * Reads one stored email through to a proposal (design section 6): choose the
 * parser, parse, match a transaction, propose. One `withScopedDb` transaction
 * holds the receipt row lock, every read the decision rests on and every write
 * (the receipt's new state, the request and its signed card), so a command that
 * refuses has written nothing (`docs/financial-calculation-contract.md` 7) and
 * a receipt never says `review` without the request that says what to review.
 *
 * Lock order inside it: the receipt row, then the advisory lock on the matched
 * transaction (`LockScope.AiReviewRequests`, the one `enqueueClaimed` takes,
 * re-entrant), then the request rows. No path of this module takes them the
 * other way round.
 *
 * Only the auto-apply runs after the commit, because `confirm` opens its own
 * transactions and needs the request to be committed as `proposed`; any
 * failure there leaves the proposal waiting in the inbox (INV-RECEIPT-003: the
 * ledger is written only through the card and `confirm`).
 */
@Injectable()
export class EmailReceiptPipelineService {
  private readonly logger = new Logger(EmailReceiptPipelineService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: AiReviewRequestsService,
    private readonly work: AiReviewWorkService,
    private readonly actions: AiActionsService,
    private readonly payees: PayeesService,
    private readonly categoryAi: EmailReceiptCategoryAiService,
    private readonly trades: EmailReceiptTradeService,
  ) {}

  async process(
    userId: string,
    receiptId: string,
    options: ProcessReceiptOptions = {},
  ): Promise<ProcessReceiptResult> {
    let committed = await withScopedDb(this.dataSource, (m) =>
      this.processInTransaction(m, userId, receiptId, options),
    );
    // A profile that wants the AI's categories: the question is asked HERE,
    // between two transactions, never inside one (a provider call must not hold a
    // row lock). The first pass wrote nothing; the second one runs with the answer.
    if (committed.needsCategories !== undefined) {
      const categoryHints = await this.askCategories(
        userId,
        committed.needsCategories,
        options.aiCategoryBudget,
      );
      committed = await withScopedDb(this.dataSource, (m) =>
        this.processInTransaction(m, userId, receiptId, {
          ...options,
          categoryHints,
        }),
      );
    }
    let result = committed.result;
    if (committed.autoApply !== null) {
      const applied = await this.autoApply(userId, committed.autoApply);
      result = { ...result, autoApplied: applied };
    }
    // A component just stored: the settlements that wait for it read it now,
    // each in its own transaction, never inside the component's (spec 8).
    for (const settlementId of committed.rejoin ?? []) {
      await this.rejoinSettlement(userId, settlementId);
    }
    return result;
  }

  /**
   * One settlement that waits for the component just stored. Not applied: an
   * ordinary automatic reprocess (matched again, joined, a new card). Applied:
   * a re-join on its own transaction. An error is logged and never fails the
   * component's result.
   */
  private async rejoinSettlement(
    userId: string,
    settlementId: string,
  ): Promise<void> {
    try {
      const rows = returnedRows<{ status: string | null }>(
        await withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT q.status
               FROM email_receipts r
               LEFT JOIN ai_review_requests q
                      ON q.id = r.ai_review_request_id AND q.user_id = r.user_id
              WHERE r.id = $1 AND r.user_id = $2`,
            [settlementId, userId],
          ),
        ),
      );
      if (rows.length === 0) return;
      if (rows[0].status === "applied") {
        await this.process(userId, settlementId, { rejoin: true });
      } else {
        await this.process(userId, settlementId, {
          onlyWhenStatusIn: REJOIN_REPROCESS_STATUSES,
        });
      }
    } catch (error) {
      this.logger.warn(
        `A waiting settlement could not be read again (${describeFailure(error)})`,
      );
    }
  }

  /**
   * The AI's category for each uncategorized item, as hints; null when it is not
   * asked (the mailbox's AI mode is `off`, the budget is spent, the in-app provider
   * cannot answer now) or does not answer: the items then stay uncategorized and
   * the request is queued for an agent. Never throws.
   */
  private async askCategories(
    userId: string,
    needs: NonNullable<Committed["needsCategories"]>,
    budget: { remaining: number } | undefined,
  ): Promise<CategoryHint[] | null> {
    if (needs.aiMode === "off") return null;
    if (budget !== undefined && budget.remaining <= 0) return null;
    let ready = false;
    try {
      ready = await this.categoryAi.canAnswerNow(userId);
    } catch (error) {
      this.logger.warn(
        `Could not tell whether the AI can answer (${describeFailure(error)})`,
      );
    }
    if (!ready) return null;
    if (budget !== undefined) budget.remaining--;
    const chosen = await this.categoryAi.categorize(
      userId,
      needs.items,
      needs.categories,
    );
    if (chosen === null) return null;
    return needs.items.flatMap((item) => {
      const categoryId = chosen.get(item.index);
      return categoryId === undefined
        ? []
        : [{ index: item.index, name: item.name, categoryId }];
    });
  }

  private async processInTransaction(
    m: EntityManager,
    userId: string,
    receiptId: string,
    options: ProcessReceiptOptions,
  ): Promise<Committed> {
    const receipt = await m.getRepository(EmailReceipt).findOne({
      where: { id: receiptId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!receipt) throw receiptNotFound(receiptId);

    if (
      options.onlyWhenStatusIn &&
      !options.onlyWhenStatusIn.includes(receipt.status)
    ) {
      return { result: unchanged(receipt), autoApply: null };
    }
    const current = await currentReceiptRequest(
      m,
      userId,
      receipt.aiReviewRequestId,
    );
    const requestStatus = current?.status ?? null;
    // A re-join (spec 8) acts only on a settlement whose card was applied, on
    // the transaction it holds; in every other case it leaves the row alone.
    if (
      options.rejoin &&
      (receipt.status !== "review" ||
        requestStatus !== "applied" ||
        current?.kind !== "email_receipt" ||
        !receipt.transactionId ||
        !receipt.matchKind)
    ) {
      return { result: unchanged(receipt), autoApply: null };
    }
    // An applied email is read again only as a component (spec 9): a component
    // reading never writes the ledger and never opens a request. Decided on the
    // row as stored, before the forwarded identity is healed, so that an applied
    // email read any other way writes nothing on an automatic pass.
    let appliedComponent = false;
    let parsers: EmailReceiptParser[] | null = null;
    if (requestStatus === "applied" && !options.rejoin) {
      parsers = await loadApprovedParsers(m, userId);
      appliedComponent =
        !options.link &&
        !receipt.investmentTransactionId &&
        receipt.status !== "skipped" &&
        readsAsComponent(
          chooseReceiptParser(
            parsers,
            receipt,
            new ReceiptSourceLines(receipt),
          ),
        );
      if (!appliedComponent && options.onlyWhenStatusIn) {
        return { result: unchanged(receipt), autoApply: null };
      }
    }
    // An automatic pass (the poll's rematch, a bulk run) never replaces a trade
    // proposal: one waiting for approval would be swapped for a new card the
    // person never saw, and one they dismissed would come back. A person's own
    // Reprocess still re-reads it; an expired one is read again too.
    if (
      options.onlyWhenStatusIn &&
      current?.kind === "email_trade" &&
      current.status !== "expired"
    ) {
      return { result: unchanged(receipt), autoApply: null };
    }
    if (!options.rejoin) {
      this.refuseUnprocessable(
        receipt,
        appliedComponent ? null : requestStatus,
        options,
      );
      await this.healForwardedIdentity(m, userId, receipt);
    }

    const link = options.link
      ? await loadLinkableTransaction(m, userId, options.link.transactionId)
      : null;

    const mailbox = await m
      .getRepository(EmailReceiptMailbox)
      .findOne({ where: { id: receipt.mailboxId, userId } });
    const aiMode: EmailReceiptAiMode = mailbox?.aiMode ?? "off";
    const autoApplyOn = mailbox?.autoApply ?? false;

    parsers ??= await loadApprovedParsers(m, userId);
    const keptLink = {
      transactionId: link?.id ?? null,
      candidateIds: [],
      matchKind: link ? ("manual" as const) : null,
    };

    // The parser that reads this sender (`chooseReceiptParser`: best first, the
    // lines of each parser's own source, an invalid definition stops the read).
    const sources = new ReceiptSourceLines(receipt);
    const choice = chooseReceiptParser(parsers, receipt, sources);
    // After the heal the email may no longer read as a component: an applied
    // one is then left alone (a person's reprocess is refused, as it always was),
    // as is a re-join of a settlement the profile no longer reads as one.
    if (
      (appliedComponent && !readsAsComponent(choice)) ||
      (options.rejoin && !readsAsSettlement(choice))
    ) {
      if (options.onlyWhenStatusIn || options.rejoin) {
        return { result: unchanged(receipt), autoApply: null };
      }
      throw appliedConflict();
    }
    if (choice.kind === "invalid") {
      return this.finish(m, userId, receipt, {
        status: "parse_failed",
        reason: "parser_invalid",
        parserId: choice.parser.id,
        parsed: null,
        requestId: null,
        ...keptLink,
      });
    }
    // A parser that reads the HTML of an email with none, and no other that
    // applies: `no_html`, not `no_parser`.
    if (choice.kind === "none" && choice.needsHtml) {
      return this.finish(m, userId, receipt, {
        status: "parse_failed",
        reason: RECEIPT_NO_HTML_REASON,
        parserId: choice.needsHtml.id,
        parsed: null,
        requestId: null,
        ...keptLink,
      });
    }
    const parser = choice.kind === "chosen" ? choice.parser : null;

    // The parser's reading, or the email's own schema.org order when no parser
    // applies or the parser found no amount (spec "Structured data"): a parser
    // that read a total always wins.
    let payee: Pick<Payee, "id" | "name" | "defaultCategoryId"> | null = null;
    let parsed: ParsedReceipt;
    let structured: ParsedReceipt | null = null;
    if (choice.kind === "chosen") {
      const { definition, guards } = choice;
      // A profile for mail that is never wanted: nothing is read, nothing is
      // asked, before any guard. (A person's own link is a command and is never
      // held back by the profile.)
      if (!link && definition.discard === "ignore") {
        return this.finish(m, userId, receipt, {
          status: "ignored",
          reason: RECEIPT_PROFILE_IGNORE_REASON,
          parserId: choice.parser.id,
          parsed: null,
          requestId: null,
          transactionId: null,
          candidateIds: [],
          matchKind: null,
        });
      }
      if (!link && definition.discard === "delete") {
        await deleteLockedReceipt(m, userId, receipt);
        return {
          result: { ...unchanged(receipt), unchanged: false, deleted: true },
          autoApply: null,
        };
      }
      // A line the parser was told to skip on: nothing to read, nothing to ask.
      // (A person's own link is a command and is never held back by a guard.)
      if (!link && guards.skipIfLine !== null) {
        return this.finish(m, userId, receipt, {
          status: "ignored",
          reason: RECEIPT_SKIP_LINE_REASON,
          parserId: choice.parser.id,
          parsed: null,
          requestId: null,
          transactionId: null,
          candidateIds: [],
          matchKind: null,
        });
      }
      // A line that says the order is not final: leave it `unmatched`, so the
      // poll's rematch reads it again (the whole pipeline, parser selection and
      // parse included) while it is within the rematch window.
      if (!link && guards.waitIfLine !== null) {
        return this.finish(m, userId, receipt, {
          status: "unmatched",
          reason: RECEIPT_WAIT_LINE_REASON,
          parserId: choice.parser.id,
          parsed: null,
          requestId: null,
          transactionId: null,
          candidateIds: [],
          matchKind: null,
        });
      }
      // A trade profile reads a brokerage confirmation: the email proposes an
      // investment transaction to CREATE, so nothing below (payee, items,
      // matching a bank transaction) applies to it.
      if (definition.trade) {
        // A link to a BANK transaction is a command about a purchase; this
        // email is now read as a trade, which is linked to an investment
        // transaction instead. Refused before anything is written, so the
        // command never turns into a booking.
        if (link) {
          throw new BadRequestException(
            tr(
              "errors.emailReceipts.tradeNotBankLinkable",
              "This email is read as a trade confirmation. Link it to an investment transaction instead.",
            ),
          );
        }
        const traded = await this.trades.process(m, userId, receipt, {
          parser: choice.parser,
          definition: definition.trade,
          lines: sources.forSource(definition.source) ?? [],
          mailboxAutoApply: autoApplyOn,
        });
        const committed = await this.finish(m, userId, receipt, {
          status: traded.status,
          reason: traded.reason,
          parserId: choice.parser.id,
          parsed: null,
          trade: traded.trade,
          investmentTransactionId: traded.investmentTransactionId,
          transactionId: null,
          candidateIds: [],
          matchKind: null,
          requestId: traded.requestId,
        });
        return { ...committed, autoApply: traded.autoApply };
      }
      payee = choice.parser.payeeId
        ? await m.getRepository(Payee).findOne({
            where: { id: choice.parser.payeeId, userId },
            select: { id: true, name: true, defaultCategoryId: true },
          })
        : null;
      parsed = parseReceiptLines(
        definition,
        receipt.subject,
        sources.forSource(definition.source),
        // A stored Transfer default is skipped (INV-CATEGORY-001).
        await categoryIdForCategoryRow(m, userId, payee?.defaultCategoryId),
      );
      // A component never looks for a bank transaction and never opens a
      // request (linked receipts spec 2.1); a person's own link is a command
      // and reads the email as a standalone one, like the guards above.
      if (!link && definition.role === "component") {
        // An applied email keeps its transaction and the applied request: the
        // receipt page still shows the earlier enrichment (spec 9).
        const base = {
          parserId: choice.parser.id,
          parsed,
          requestId: appliedComponent ? receipt.aiReviewRequestId : null,
          transactionId: appliedComponent ? receipt.transactionId : null,
          candidateIds: [],
          matchKind: appliedComponent ? receipt.matchKind : null,
        };
        if (!parsed.linkKey) {
          return this.finish(m, userId, receipt, {
            ...base,
            status: "parse_failed",
            reason: RECEIPT_NO_LINK_KEY_REASON,
          });
        }
        const stored = await this.finish(m, userId, receipt, {
          ...base,
          status: "component",
          reason: await componentReason(
            m,
            userId,
            receipt.id,
            componentNet(parsed),
          ),
          linkKey: parsed.linkKey,
        });
        return {
          ...stored,
          rejoin: (
            await waitingSettlements(
              m,
              userId,
              receipt.id,
              parsed.linkKey,
              MAX_REJOINED_SETTLEMENTS,
            )
          ).map((settlement) => settlement.id),
        };
      }
      // A re-join leaves an email that read no amount alone.
      if (options.rejoin && parsed.total === null && parsed.paid === null) {
        return { result: unchanged(receipt), autoApply: null };
      }
      if (parsed.total === null && parsed.paid === null) {
        structured = await this.readStructured(userId, sources);
        if (structured) parsed = structured;
      }
    } else {
      structured = await this.readStructured(userId, sources);
      if (!structured) {
        return this.finish(m, userId, receipt, {
          status: "no_parser",
          reason: null,
          parserId: null,
          parsed: null,
          requestId: null,
          ...keptLink,
        });
      }
      parsed = structured;
    }
    // Some linked part of a settlement stayed one line (set by the join below).
    let partiallyLinked = false;
    // The reason slot a schema.org reading, or a partly linked settlement,
    // fills when the outcome has none of its own.
    const reasonOf = (reason: string | null): string | null =>
      reason ??
      (partiallyLinked ? RECEIPT_PARTIALLY_LINKED_REASON : null) ??
      (structured ? RECEIPT_SCHEMA_ORG_REASON : null);
    // What the profile says about matching (spec 3a); the defaults when no
    // parser read the email (schema.org, no parser).
    const matchConfig = resolveMatchConfig(
      choice.kind === "chosen" ? choice.definition.match : undefined,
    );
    let stored: {
      parserId: string | null;
      parsed: ParsedReceipt;
      links?: LinkRowInput[];
      componentReasons?: JoinedSettlement["componentReasons"];
    } = { parserId: parser?.id ?? null, parsed };
    // The day the shop sent the order when a forward carried it, else the day
    // the email arrived (spec "Matching" section 3).
    const purchaseDate = effectiveReceiptDate(receipt)
      .toISOString()
      .slice(0, 10);

    if (
      !link &&
      parsed.total === null &&
      parsed.paid === null &&
      !parsed.orderId &&
      !parsed.reference
    ) {
      return this.finish(m, userId, receipt, {
        status: "parse_failed",
        reason: parsed.reason ?? "no_total",
        requestId: null,
        ...keptLink,
        ...stored,
      });
    }

    // A settlement (linked receipts spec 4): each part is replaced by the lines
    // of the purchase email it pays for. A reading that came from schema.org
    // does not join. The component rows are locked here, after the receipt's
    // own row and before the advisory lock on the matched transaction (spec 11).
    const isSettlement =
      structured === null &&
      choice.kind === "chosen" &&
      choice.definition.role === "settlement";
    let joinedTagNames: string[] = [];
    const joinedComponentIds = new Set<string>();
    if (isSettlement && choice.kind === "chosen") {
      const parts = await loadLinkedComponents(
        m,
        userId,
        { id: receipt.id, effectiveDate: purchaseDate },
        parsed.items.map((item) => item.link ?? null),
        choice.definition.link ?? {},
        true,
      );
      const joined = joinSettlement(parsed, parts);
      // A re-join writes only when a part that was not joined now is (spec 8).
      if (
        options.rejoin &&
        !joinImproved(receipt.parsed as ParsedReceipt | null, joined.reports)
      ) {
        return { result: unchanged(receipt), autoApply: null };
      }
      parsed = joined.parsed;
      joinedTagNames = joined.tagNames;
      for (const report of joined.reports) {
        if (
          (report.outcome === "joined" || report.outcome === "scaled") &&
          report.componentReceiptId !== null
        ) {
          joinedComponentIds.add(report.componentReceiptId);
        }
      }
      partiallyLinked = joined.reports.some(
        (report) =>
          report.link !== null &&
          report.outcome !== "joined" &&
          report.outcome !== "scaled",
      );
      stored = {
        ...stored,
        parsed,
        links: linkRowsOf(joined.reports),
        componentReasons: joined.componentReasons,
      };
    }

    let transaction: TransactionFacts;
    let matchKind: EmailReceiptMatchKind;
    if (link) {
      transaction = link;
      matchKind = "manual";
    } else if (options.rejoin) {
      // No new match: the settlement's own transaction, under the refusals of a
      // link; the match kind it was stored with (checked above).
      transaction = await loadLinkableTransaction(
        m,
        userId,
        receipt.transactionId as string,
      );
      matchKind = receipt.matchKind as EmailReceiptMatchKind;
    } else {
      // The window is centred on `purchaseDate` (spec section 3). A settlement
      // also sees the transactions another email enriched (linked receipts 6).
      const candidates = await loadReceiptCandidates(
        m,
        userId,
        purchaseDate,
        receipt.id,
        matchConfig,
        isSettlement,
      );
      const match = matchReceipt(
        parsed,
        purchaseDate,
        candidates,
        parser?.payeeId ?? null,
        matchConfig,
      );
      if (match.kind === "unmatched") {
        return this.finish(m, userId, receipt, {
          status: "unmatched",
          reason: reasonOf(null),
          transactionId: null,
          candidateIds: [],
          matchKind: null,
          requestId: null,
          ...stored,
        });
      }
      if (match.kind === "ambiguous") {
        return this.finish(m, userId, receipt, {
          status: "ambiguous",
          reason: reasonOf(null),
          transactionId: null,
          candidateIds: match.candidateIds,
          matchKind: null,
          requestId: null,
          ...stored,
        });
      }
      const hit = candidates.find((c) => c.id === match.transactionId);
      if (!hit) throw new Error("A matched candidate is not in the candidates");
      // The transaction was enriched by an email this settlement does not join:
      // a person decides (the Link action proposes over it). One enriched by a
      // component this settlement joins is replaced by the new card.
      if (
        isSettlement &&
        hit.enrichedByReceiptId &&
        hit.enrichedByReceiptId !== receipt.id &&
        !joinedComponentIds.has(hit.enrichedByReceiptId)
      ) {
        return this.finish(m, userId, receipt, {
          status: "review_conflict",
          reason: RECEIPT_ENRICHED_BY_OTHER_REASON,
          transactionId: null,
          candidateIds: [hit.id],
          matchKind: null,
          requestId: null,
          ...stored,
        });
      }
      transaction = {
        id: hit.id,
        amount: hit.amount,
        description: hit.description,
        payeeId: hit.payeeId,
        referenceNumber: hit.referenceNumber,
      };
      matchKind = match.matchKind;
    }

    const categoryNames = await loadQualifiedCategoryNames(m, userId);

    // What the user already filed an item of the same name under comes first;
    // the profile's rules, then the AI, cover what history does not.
    const history = await loadItemCategoryHistory(
      m,
      userId,
      parsed.items.filter(isItemLine).map((item) => item.name),
    );
    const withHistory = applyCategoryHistory(parsed, history, categoryNames);
    if (withHistory !== parsed) {
      parsed = withHistory;
      stored = { ...stored, parsed };
    }

    // A profile that asks the AI for the categories of the items its rules left
    // bare (design 5.6): only a parser's own reading, only when the sole thing
    // missing is those categories, and only once a transaction matched.
    let queueCategorize = false;
    if (
      parser !== null &&
      structured === null &&
      choice.kind === "chosen" &&
      choice.definition.aiCategories === true &&
      parsed.reason === "items_uncategorized" &&
      parsed.items.some((item) => isItemLine(item) && item.categoryId === null)
    ) {
      const hints = options.categoryHints;
      if (hints === undefined) {
        return {
          result: unchanged(receipt),
          autoApply: null,
          needsCategories: {
            aiMode,
            categories: categoryNames,
            items: parsed.items.flatMap((item, index) =>
              isItemLine(item) && item.categoryId === null
                ? [
                    {
                      index,
                      name: item.name,
                      qty: item.qty,
                      amount: item.amount,
                    },
                  ]
                : [],
            ),
          },
        };
      }
      if (hints === null) {
        queueCategorize = true;
      } else {
        parsed = applyCategoryHints(parsed, hints, categoryNames);
        stored = { ...stored, parsed };
      }
    }

    const matched = {
      transactionId: transaction.id,
      candidateIds: [] as string[],
      matchKind,
      ...stored,
    };
    // A schema.org reading with no parser behind it is labelled by the sender's
    // domain (as an AI reading is) and names no gateway payee of its own.
    const context: ReceiptProposalContext = {
      parserName: parser?.name ?? receipt.fromDomain,
      parserPayeeId: parser?.payeeId ?? null,
      payeeName: structured && !parser ? null : (payee?.name ?? null),
      categoryNames,
      // The profile's tag goes on what the profile itself read, never on a
      // schema.org reading a parser fell back to.
      tagName:
        structured === null && choice.kind === "chosen"
          ? (choice.definition.tag ?? null)
          : null,
      // The tags of the profiles of the joined components (spec 7).
      ...(isSettlement ? { extraTagNames: joinedTagNames } : {}),
    };
    const proposal = buildReceiptProposal(parsed, transaction, context);
    const askAi = aiMode === "automatic" && !parsed.complete;

    // The AI could not be asked for the categories: keep them bare and queue the
    // request for the chat or an agent instead of a description-only proposal. A
    // transaction carries at most one open request without a rule (design 4), so
    // this IS the receipt's request until an agent answers it.
    if (queueCategorize) {
      await lockReceiptTransaction(m, transaction.id);
      await closeReceiptRequests(m, userId, receipt.id);
      const request = await this.requests.enqueuePendingForReceipt(m, userId, {
        transactionId: transaction.id,
        emailReceiptId: receipt.id,
        instruction: RECEIPT_CATEGORIZE_INSTRUCTION,
      });
      return this.finish(
        m,
        userId,
        receipt,
        request
          ? {
              status: "review",
              reason: reasonOf(parsed.reason),
              requestId: request.id,
              ...matched,
            }
          : {
              status: "review_conflict",
              reason: reasonOf(null),
              requestId: null,
              ...matched,
            },
      );
    }

    if (!askAi && proposal.input === null) {
      return this.finish(m, userId, receipt, {
        status: "parse_failed",
        reason: "nothing_to_propose",
        requestId: null,
        ...matched,
      });
    }

    // The receipt row is locked; now the advisory lock the queue's exclusion
    // rests on, before any request row is written or closed.
    await lockReceiptTransaction(m, transaction.id);
    await closeReceiptRequests(m, userId, receipt.id);

    if (askAi) {
      const request = await this.requests.enqueuePendingForReceipt(m, userId, {
        transactionId: transaction.id,
        emailReceiptId: receipt.id,
        instruction: RECEIPT_AUTOMATIC_AI_INSTRUCTION,
      });
      return this.finish(
        m,
        userId,
        receipt,
        request
          ? {
              status: "review",
              reason: reasonOf(proposal.reason),
              requestId: request.id,
              ...matched,
            }
          : {
              status: "review_conflict",
              reason: reasonOf(null),
              requestId: null,
              ...matched,
            },
      );
    }

    const request = await this.requests.enqueueClaimed(m, userId, {
      transactionId: transaction.id,
      kind: "email_receipt",
      emailReceiptId: receipt.id,
      instruction: RECEIPT_PARSED_INSTRUCTION,
      claimedBy: EMAIL_RECEIPTS_CLAIM_KEY,
    });
    if (!request) {
      return this.finish(m, userId, receipt, {
        status: "review_conflict",
        reason: reasonOf(null),
        requestId: null,
        ...matched,
      });
    }

    const submitted = await this.submitProposal(
      m,
      userId,
      request.id,
      proposal,
      { parsed, transaction, context },
    );
    if (submitted.kind === "refused") {
      return this.finish(m, userId, receipt, {
        status: "review",
        reason: "proposal_refused",
        requestId: request.id,
        ...matched,
      });
    }

    const gate: AutoApplyFacts = {
      mailboxAutoApply: autoApplyOn,
      parserStatus: parser?.status ?? "draft",
      parsed,
      transactionAmount: transaction.amount,
      matchKind,
      proposalKind: proposal.kind,
      usedFallback: submitted.usedFallback,
      cardBuilt: true,
      linked: hasJoinedPart(parsed),
      forwarded: isForwardedReceipt(receipt),
    };
    const committed = await this.finish(m, userId, receipt, {
      status: "review",
      reason: submitted.usedFallback
        ? "proposal_fallback"
        : reasonOf(proposal.reason ?? null),
      requestId: request.id,
      ...matched,
    });
    return {
      result: committed.result,
      autoApply: autoApplyAllowed(gate) ? submitted.action : null,
    };
  }

  /**
   * The email's own schema.org order as a receipt (`readSchemaOrgReceipt`): the
   * seller is looked up with `PayeesService.resolveByName`, which never creates
   * a payee. Reads only, inside the receipt's transaction.
   */
  private readStructured(
    userId: string,
    sources: ReceiptSourceLines,
  ): Promise<ParsedReceipt | null> {
    return readSchemaOrgReceipt(sources, (name) =>
      this.payees.resolveByName(userId, name),
    );
  }

  /**
   * Store the proposal as an agent would (`AiReviewWorkService.submit`, inside
   * this same transaction: its reads and the conditional UPDATE join it). A
   * refusal of the itemized proposal (the lines do not add up, a category was
   * deleted) is retried once with the description only; a refusal of that too
   * closes the request as rejected with the reason (design section 6).
   */
  private async submitProposal(
    m: EntityManager,
    userId: string,
    requestId: string,
    proposal: ReceiptProposal,
    source: {
      parsed: ParsedReceipt;
      transaction: TransactionFacts;
      context: ReceiptProposalContext;
    },
  ): Promise<
    | { kind: "stored"; action: PendingAiAction; usedFallback: boolean }
    | { kind: "refused" }
  > {
    const input = proposal.input as AiReviewProposalInput;
    try {
      const done = await this.work.submit(
        userId,
        EMAIL_RECEIPTS_CLAIM_KEY,
        requestId,
        input,
      );
      return { kind: "stored", action: done.action, usedFallback: false };
    } catch (error) {
      if (!isRefusal(error)) throw error;
      let note = refusalNote(error);
      if (proposal.kind !== "description_only") {
        const fallback = buildReceiptProposal(
          {
            ...source.parsed,
            complete: false,
            reason: source.parsed.reason ?? "items_unbalanced",
          },
          source.transaction,
          source.context,
        );
        if (fallback.input !== null) {
          try {
            const done = await this.work.submit(
              userId,
              EMAIL_RECEIPTS_CLAIM_KEY,
              requestId,
              fallback.input,
            );
            return { kind: "stored", action: done.action, usedFallback: true };
          } catch (retryError) {
            if (!isRefusal(retryError)) throw retryError;
            note = refusalNote(retryError);
          }
        }
      }
      await this.requests.release(userId, requestId, EMAIL_RECEIPTS_CLAIM_KEY, {
        final: true,
        note,
      });
      return { kind: "refused" };
    }
  }

  /**
   * A forwarded email whose sender, subject and date are still the forwarder's
   * (stored before forwards were understood, or by a detector that has since
   * improved) is read again from its stored text, under the receipt's row lock,
   * and the identity columns are brought up to date before the parser is chosen.
   * Only the owner's own forward is re-identified; a row another sender's
   * pasted block re-identified is put back under that sender
   * (`resolveForwardedIdentity`, A26-H02).
   * Idempotent: an email already healed, or one that is no forward, is left as
   * it is and nothing is written. `receipt` is updated in place so the rest of
   * the transaction sees the healed row.
   */
  private async healForwardedIdentity(
    m: EntityManager,
    userId: string,
    receipt: EmailReceipt,
  ): Promise<void> {
    const current: ReceiptIdentity = {
      fromAddress: receipt.fromAddress,
      fromDomain: receipt.fromDomain,
      subject: receipt.subject,
      forwardedBy: receipt.forwardedBy ?? null,
      originalSentAt: receipt.originalSentAt ?? null,
    };
    if (!mayBeForwarded(current, receipt.bodyText)) return;
    const healed = resolveForwardedIdentity(
      current,
      receipt.bodyText,
      receipt.receivedAt,
      await loadOwnAddresses(m, userId),
    );
    if (healed === null || sameIdentity(current, healed)) return;
    await m.getRepository(EmailReceipt).update(
      { id: receipt.id, userId },
      {
        fromAddress: healed.fromAddress,
        fromDomain: healed.fromDomain,
        subject: healed.subject,
        forwardedBy: healed.forwardedBy,
        originalSentAt: healed.originalSentAt,
      },
    );
    Object.assign(receipt, healed);
  }

  /** The refusals that stop a person's command before anything is written. */
  private refuseUnprocessable(
    receipt: EmailReceipt,
    requestStatus: string | null,
    options: ProcessReceiptOptions,
  ): void {
    if (receipt.status === "skipped") {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.receiptSkipped",
          "This email could not be read (it was too large or could not be decoded), so there is nothing to process.",
        ),
      );
    }
    if (requestStatus === "applied") throw appliedConflict();
    // A trade email linked to the ledger row it reports, or whose approval
    // booked one, accounts for that row: read again, it would propose the same
    // trade a second time.
    if (
      Boolean(receipt.investmentTransactionId) &&
      receipt.statusReason !== RECEIPT_TRADE_EXISTS_REASON
    ) {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.tradeAccountedFor",
          "This email already accounts for an investment transaction, so it is not read again.",
        ),
      );
    }
    if (options.link && receipt.status === "ignored") {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.receiptIgnored",
          "This email was ignored. Reprocess it before linking it to a transaction.",
        ),
      );
    }
  }

  /** Close what the receipt no longer backs, store its new state, and report it. */
  private async finish(
    m: EntityManager,
    userId: string,
    receipt: EmailReceipt,
    stored: Stored,
  ): Promise<Committed> {
    // An outcome that holds no request of its own closes the ones the receipt
    // had; one that holds a request has just created it, and must not.
    if (stored.requestId === null) {
      await closeReceiptRequests(m, userId, receipt.id);
    }
    await m.getRepository(EmailReceipt).update(
      { id: receipt.id, userId },
      {
        status: stored.status,
        statusReason: stored.reason,
        parserId: stored.parserId,
        parsed:
          stored.parsed as unknown as QueryDeepPartialEntity<EmailReceipt>["parsed"],
        trade: (stored.trade ??
          null) as unknown as QueryDeepPartialEntity<EmailReceipt>["trade"],
        investmentTransactionId: stored.investmentTransactionId ?? null,
        linkKey: stored.linkKey ?? null,
        transactionId: stored.transactionId,
        candidateTransactionIds: stored.candidateIds,
        matchKind: stored.matchKind,
        aiReviewRequestId: stored.requestId,
      },
    );
    // The settlement's link rows are replaced every time it is stored (spec 5).
    await replaceLinkRows(m, userId, receipt.id, stored.links);
    // The component rows are locked since the join (spec 11).
    for (const { receiptId, reason } of stored.componentReasons ?? []) {
      await m.query(
        `UPDATE email_receipts SET status_reason = $1
          WHERE id = $2 AND user_id = $3 AND status = 'component'`,
        [reason, receiptId, userId],
      );
    }
    return {
      result: {
        status: stored.status,
        statusReason: stored.reason,
        transactionId: stored.transactionId,
        matchKind: stored.matchKind,
        requestId: stored.requestId,
        autoApplied: false,
        unchanged: false,
        deleted: false,
      },
      autoApply: null,
    };
  }

  /**
   * Confirm the card the pipeline built, exactly as a person's approval does
   * (`/ai/actions/confirm`): the signature, the expiry, the anti-replay claim,
   * the daily write cap and the request's own `markApplied` all still apply.
   * Any refusal leaves the proposal waiting in the inbox.
   */
  private async autoApply(
    userId: string,
    action: PendingAiAction,
  ): Promise<boolean> {
    try {
      await this.actions.confirm(userId, {
        actionId: action.actionId,
        signature: action.signature,
        descriptor: action.descriptor as unknown as Record<string, unknown>,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Receipt auto-apply was refused; the proposal stays in the inbox (${describeFailure(error)})`,
      );
      return false;
    }
  }
}

/**
 * The reading with the AI's categories filled in (design 5.6): each hint sets the
 * category of the item at its index when that item is still bare, has the name the
 * hint was asked about (the reading may have changed since) and the id is one of
 * the user's categories; the item is marked `categorySource: "ai"`. Completeness is
 * judged again by the one function a parser's reading is judged by.
 */
export function applyCategoryHints(
  parsed: ParsedReceipt,
  hints: readonly CategoryHint[],
  categories: ReadonlyMap<string, string>,
): ParsedReceipt {
  const items = parsed.items.map((item, index) => {
    const hint = hints.find((h) => h.index === index);
    return hint !== undefined &&
      item.categoryId === null &&
      hint.name === item.name &&
      categories.has(hint.categoryId)
      ? { ...item, categoryId: hint.categoryId, categorySource: "ai" as const }
      : item;
  });
  const next = { ...parsed, items };
  const reason = completeness(next);
  return { ...next, complete: reason === null, reason };
}

function appliedConflict(): ConflictException {
  return new ConflictException(
    tr(
      "errors.emailReceipts.receiptApplied",
      "This email's proposal has already been applied to a transaction.",
    ),
  );
}

/**
 * Whether the chosen profile reads the email as a component: an approved
 * `component` profile that no guard, discard or trade section turns into
 * another outcome first. The one question an applied email is asked (spec 9).
 */
function readsAsComponent(choice: ReceiptParserChoice): boolean {
  return (
    choice.kind === "chosen" &&
    choice.definition.role === "component" &&
    !choice.definition.discard &&
    !choice.definition.trade &&
    choice.guards.skipIfLine === null &&
    choice.guards.waitIfLine === null
  );
}

/** The mirror for a re-join (spec 8): a settlement profile no guard turns aside. */
function readsAsSettlement(choice: ReceiptParserChoice): boolean {
  return (
    choice.kind === "chosen" &&
    choice.definition.role === "settlement" &&
    !choice.definition.discard &&
    !choice.definition.trade &&
    choice.guards.skipIfLine === null &&
    choice.guards.waitIfLine === null
  );
}

/**
 * Spec 8: some part that the stored reading did not join (`joined` or `scaled`)
 * is joined by the new one. A part the stored reading has no entry for does not
 * count.
 */
function joinImproved(
  stored: ParsedReceipt | null,
  reports: readonly ReceiptLinkReport[],
): boolean {
  const isJoin = (outcome: ReceiptLinkOutcome): boolean =>
    outcome === "joined" || outcome === "scaled";
  const before = new Map(
    (stored?.links ?? []).map((report) => [report.partIndex, report.outcome]),
  );
  return reports.some((report) => {
    const was = before.get(report.partIndex);
    return was !== undefined && !isJoin(was) && isJoin(report.outcome);
  });
}

function unchanged(receipt: EmailReceipt): ProcessReceiptResult {
  return {
    status: receipt.status,
    statusReason: receipt.statusReason,
    transactionId: receipt.transactionId,
    matchKind: receipt.matchKind,
    requestId: receipt.aiReviewRequestId,
    autoApplied: false,
    unchanged: true,
    deleted: false,
  };
}

function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}
