import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import { EmailReceiptPipelineService } from "../pipeline/email-receipt-pipeline.service";
import {
  closeReceiptRequests,
  currentReceiptRequestStatus,
  lockReceiptTransaction,
} from "../pipeline/receipt-requests.util";
import {
  EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT,
  EMAIL_RECEIPTS_MAX_LIST_LIMIT,
} from "./dto/email-receipts.dto";
import type {
  EmailReceiptCandidateSummary,
  EmailReceiptDetail,
  EmailReceiptDisplayState,
  EmailReceiptListItem,
} from "./email-receipt.view";

/** The request a receipt points at, as far as the derived state needs it. */
export interface ReceiptRequestFacts {
  status: string;
  /** The request's life has run out, whatever its stored status still says. */
  expired: boolean;
}

/**
 * The shown state of a `review` receipt, derived from its request (design
 * section 6). Null for every other status: only a receipt that stands behind a
 * request has a request's state to show.
 */
export function deriveDisplayState(
  status: EmailReceiptStatus,
  request: ReceiptRequestFacts | null,
): EmailReceiptDisplayState | null {
  if (status !== "review") return null;
  if (request === null) return "request_missing";
  switch (request.status) {
    case "applied":
      return "applied";
    case "rejected":
      return "dismissed";
    case "expired":
      return "expired";
    case "proposed":
      return request.expired ? "expired" : "proposed";
    default:
      // pending, claimed
      return request.expired ? "expired" : "pending_ai";
  }
}

interface ItemRow {
  id: string;
  from_address: string;
  from_domain: string;
  subject: string;
  received_at: Date | string;
  created_at: Date | string;
  status: EmailReceiptStatus;
  status_reason: string | null;
  match_kind: EmailReceiptListItem["matchKind"];
  parser_id: string | null;
  parser_name: string | null;
  ai_review_request_id: string | null;
  request_status: string | null;
  request_expired: boolean | null;
  request_note: string | null;
  transaction_id: string | null;
  tx_date: string | null;
  tx_amount: string | number | null;
  tx_currency: string | null;
  tx_payee: string | null;
}

interface DetailRow extends ItemRow {
  body_text: string;
  parsed: Record<string, unknown> | null;
  candidate_transaction_ids: string[];
}

const ITEM_COLUMNS = `r.id, r.from_address, r.from_domain, r.subject, r.received_at,
       r.created_at, r.status, r.status_reason, r.match_kind, r.parser_id,
       p.name AS parser_name, r.ai_review_request_id,
       rq.status AS request_status,
       (rq.expires_at <= CURRENT_TIMESTAMP) AS request_expired,
       rq.proposal #>> '{agentNote,reason}' AS request_note,
       r.transaction_id,
       TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
       t.amount AS tx_amount, t.currency_code AS tx_currency,
       t.payee_name AS tx_payee`;

const ITEM_JOINS = `FROM email_receipts r
       LEFT JOIN email_receipt_parsers p
              ON p.id = r.parser_id AND p.user_id = r.user_id
       LEFT JOIN ai_review_requests rq
              ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id
       LEFT JOIN transactions t
              ON t.id = r.transaction_id AND t.user_id = r.user_id`;

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function toListItem(row: ItemRow): EmailReceiptListItem {
  return {
    id: row.id,
    fromAddress: row.from_address,
    fromDomain: row.from_domain,
    subject: row.subject,
    receivedAt: iso(row.received_at),
    status: row.status,
    statusReason: row.status_reason,
    matchKind: row.match_kind,
    parserId: row.parser_id,
    parserName: row.parser_name,
    aiReviewRequestId: row.ai_review_request_id,
    displayState: deriveDisplayState(
      row.status,
      row.request_status === null
        ? null
        : {
            status: row.request_status,
            expired: row.request_expired === true,
          },
    ),
    requestNote: row.request_note,
    transaction:
      row.transaction_id !== null && row.tx_date !== null
        ? {
            id: row.transaction_id,
            date: row.tx_date,
            amount: Number(row.tx_amount),
            currencyCode: row.tx_currency as string,
            payeeName: row.tx_payee,
          }
        : null,
    createdAt: iso(row.created_at),
  };
}

/**
 * The receipts page's API over the stored emails (design sections 6 and 8): the
 * list, one email with its text, and the person's commands on it. Every method
 * is keyed on the JWT's user. A command that can refuse (an applied proposal, an
 * ignored or skipped email, a transaction that is not the user's) refuses inside
 * the transaction that would write, under the receipt's row lock, so a
 * rejection has written nothing.
 */
@Injectable()
export class EmailReceiptsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly pipeline: EmailReceiptPipelineService,
  ) {}

  /** The user's emails, newest first, without their text. */
  async list(
    userId: string,
    options: { status?: EmailReceiptStatus; limit?: number } = {},
  ): Promise<EmailReceiptListItem[]> {
    const limit = Math.min(
      Math.max(
        Math.trunc(options.limit ?? EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT),
        1,
      ),
      EMAIL_RECEIPTS_MAX_LIST_LIMIT,
    );
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<ItemRow>(
        await m.query(
          `SELECT ${ITEM_COLUMNS}
             ${ITEM_JOINS}
            WHERE r.user_id = $1
              AND ($2::varchar IS NULL OR r.status = $2::varchar)
            ORDER BY r.received_at DESC, r.id DESC
            LIMIT $3`,
          [userId, options.status ?? null, limit],
        ),
      ),
    );
    return rows.map(toListItem);
  }

  /** One of the user's emails with its text, parse result and candidates. */
  async get(userId: string, id: string): Promise<EmailReceiptDetail> {
    const detail = await withScopedDb(this.dataSource, (m) =>
      this.readDetail(m, userId, id),
    );
    if (!detail) throw receiptNotFound(id);
    return detail;
  }

  /** Back to the top of the pipeline (design section 6); a closed request is not reopened. */
  async reprocess(userId: string, id: string): Promise<EmailReceiptDetail> {
    await this.pipeline.process(userId, id);
    return this.get(userId, id);
  }

  /**
   * A person names the transaction the email paid for (match kind `manual`) and
   * the pipeline proposes from it. Ownership, transfer and VOID are checked by
   * the pipeline inside the transaction that stores the link.
   */
  async link(
    userId: string,
    id: string,
    transactionId: string,
  ): Promise<EmailReceiptDetail> {
    await this.pipeline.process(userId, id, { link: { transactionId } });
    return this.get(userId, id);
  }

  /** Stop the email proposing anything: its open request is dismissed with it. */
  async ignore(userId: string, id: string): Promise<EmailReceiptDetail> {
    await withScopedDb(this.dataSource, async (m) => {
      const receipt = await this.lockReceipt(m, userId, id);
      if (receipt.status === "ignored") return;
      if (receipt.status === "skipped") {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptSkipped",
            "This email could not be read (it was too large or could not be decoded), so there is nothing to process.",
          ),
        );
      }
      await this.refuseWhenApplied(m, userId, receipt);
      if (receipt.transactionId) {
        await lockReceiptTransaction(m, receipt.transactionId);
      }
      await closeReceiptRequests(m, userId, id);
      await m
        .getRepository(EmailReceipt)
        .update(
          { id, userId },
          { status: "ignored", statusReason: null, aiReviewRequestId: null },
        );
    });
    return this.get(userId, id);
  }

  /** Delete the stored email; its open request is dismissed in the same transaction. */
  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const receipt = await this.lockReceipt(m, userId, id);
      if (receipt.transactionId) {
        await lockReceiptTransaction(m, receipt.transactionId);
      }
      await closeReceiptRequests(m, userId, id);
      await m.getRepository(EmailReceipt).delete({ id, userId });
    });
  }

  // ---------------------------------------------------------------------

  private async lockReceipt(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceipt> {
    const receipt = await m.getRepository(EmailReceipt).findOne({
      where: { id, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!receipt) throw receiptNotFound(id);
    return receipt;
  }

  private async refuseWhenApplied(
    m: EntityManager,
    userId: string,
    receipt: EmailReceipt,
  ): Promise<void> {
    const status = await currentReceiptRequestStatus(
      m,
      userId,
      receipt.aiReviewRequestId,
    );
    if (status === "applied") {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.receiptApplied",
          "This email's proposal has already been applied to a transaction.",
        ),
      );
    }
  }

  private async readDetail(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceiptDetail | null> {
    const rows = returnedRows<DetailRow>(
      await m.query(
        `SELECT ${ITEM_COLUMNS},
                r.body_text, r.parsed, r.candidate_transaction_ids
           ${ITEM_JOINS}
          WHERE r.user_id = $1
            AND r.id = $2`,
        [userId, id],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...toListItem(row),
      bodyText: row.body_text,
      parsed: row.parsed,
      candidates: await this.readCandidates(
        m,
        userId,
        row.candidate_transaction_ids ?? [],
      ),
    };
  }

  /** The candidates of an ambiguous email, in the stored order (closest date first). */
  private async readCandidates(
    m: EntityManager,
    userId: string,
    ids: readonly string[],
  ): Promise<EmailReceiptCandidateSummary[]> {
    if (ids.length === 0) return [];
    const rows = returnedRows<{
      id: string;
      date: string;
      amount: string | number;
      currency_code: string;
      payee_name: string | null;
      description: string | null;
    }>(
      await m.query(
        `SELECT t.id, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
                t.amount, t.currency_code, t.payee_name, t.description
           FROM transactions t
          WHERE t.user_id = $1
            AND t.id = ANY($2::uuid[])`,
        [userId, [...ids]],
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            {
              id: row.id,
              date: row.date,
              amount: Number(row.amount),
              currencyCode: row.currency_code,
              payeeName: row.payee_name,
              description: row.description,
            },
          ]
        : [];
    });
  }
}

function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}
