import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager, QueryDeepPartialEntity } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { Payee } from "../../payees/entities/payee.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  matchReceipt,
  type ReceiptMatchResult,
} from "../matching/match-receipt";
import { loadReceiptCandidates } from "../pipeline/receipt-candidates";
import { parseReceipt } from "../parsing/parse-receipt";
import type {
  ParsedReceipt,
  ReceiptParserDefinition,
} from "../parsing/receipt-parser.types";
import {
  collectParserCategoryIds,
  validateReceiptParserDefinition,
} from "../parsing/receipt-parser.validation";
import {
  ApproveEmailReceiptParserDto,
  CreateEmailReceiptParserDto,
  TestEmailReceiptParserDto,
  UpdateEmailReceiptParserDto,
} from "./dto/email-receipt-parser.dto";
import {
  toParserView,
  type EmailReceiptParserView,
} from "./email-receipt-parser.view";
import {
  assertParserReferencesOwned,
  invalidDefinitionError,
} from "./parser-references.util";

/** A user holds at most this many parsers: the pipeline reads them all for each email. */
export const MAX_PARSERS_PER_USER = 200;

/** What a parser test returns: the read, and what the matcher would do with it. */
export interface EmailReceiptParserTestResult {
  parsed: ParsedReceipt;
  match: ReceiptMatchResult;
  /** Candidate transactions the matcher was given (at most 200). */
  candidateCount: number;
  /** The matched transaction, when there is one. */
  transaction: {
    id: string;
    date: string;
    amount: number;
    payeeName: string | null;
  } | null;
}

/**
 * The parsers a user owns (design sections 5 and 8): create, edit under a
 * compare-and-swap revision, approve, delete, and test a draft definition
 * against a stored email without writing anything. A definition is validated by
 * the one validator the AI draft also passes; a payee or category the user does
 * not own is refused in the write's own transaction.
 */
@Injectable()
export class EmailReceiptParsersService {
  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string): Promise<EmailReceiptParserView[]> {
    const rows = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(EmailReceiptParser).find({
        where: { userId },
        order: { name: "ASC", id: "ASC" },
        take: MAX_PARSERS_PER_USER * 5,
      }),
    );
    return rows.map(toParserView);
  }

  async get(userId: string, id: string): Promise<EmailReceiptParserView> {
    const row = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(EmailReceiptParser).findOne({ where: { id, userId } }),
    );
    if (!row) throw parserNotFound(id);
    return toParserView(row);
  }

  /** A manual parser is approved on creation: the person who wrote it is the approval. */
  async create(
    userId: string,
    dto: CreateEmailReceiptParserDto,
  ): Promise<EmailReceiptParserView> {
    const definition = validDefinition(dto.definition);
    const row = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      // The cap is a bound on work per email, not a security limit: two
      // concurrent creates can overshoot it by one.
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
        payeeId: dto.payeeId ?? null,
        categoryIds: collectParserCategoryIds(definition),
      });
      return repo.save(
        repo.create({
          userId,
          name: dto.name,
          payeeId: dto.payeeId ?? null,
          fromDomains: unique(dto.fromDomains),
          subjectContains: unique(dto.subjectContains ?? []),
          definition: definition as unknown as Record<string, unknown>,
          status: "approved",
          source: "manual",
          approvedAt: new Date(),
        }),
      );
    });
    return toParserView(row);
  }

  /**
   * Change a parser the caller has read at `expectedRevision`. The row is locked
   * first and the revision compared under the lock (404 for a missing row, 409
   * for one that has moved on), every reference is checked, and only then is
   * anything written. The status is unchanged: an approved parser stays
   * approved, because the person editing it is its author.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateEmailReceiptParserDto,
  ): Promise<EmailReceiptParserView> {
    const definition =
      dto.definition === undefined
        ? undefined
        : validDefinition(dto.definition);
    const row = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      const existing = await this.lockParser(m, userId, id);
      if (existing.revision !== dto.expectedRevision) {
        throw revisionConflict();
      }
      const payeeId =
        dto.payeeId === undefined ? existing.payeeId : (dto.payeeId ?? null);
      await assertParserReferencesOwned(m, userId, {
        payeeId: payeeId !== existing.payeeId ? payeeId : null,
        categoryIds: definition ? collectParserCategoryIds(definition) : [],
      });
      await repo.update(
        { id, userId },
        {
          ...(dto.name === undefined ? {} : { name: dto.name }),
          payeeId,
          ...(dto.fromDomains === undefined
            ? {}
            : { fromDomains: unique(dto.fromDomains) }),
          ...(dto.subjectContains === undefined
            ? {}
            : { subjectContains: unique(dto.subjectContains) }),
          ...(definition === undefined
            ? {}
            : {
                definition:
                  definition as unknown as QueryDeepPartialEntity<EmailReceiptParser>["definition"],
              }),
          revision: () => "revision + 1",
        },
      );
      return repo.findOneByOrFail({ id, userId });
    });
    return toParserView(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(EmailReceiptParser).delete({ id, userId }),
    );
    if (!deleted.affected) throw parserNotFound(id);
  }

  /**
   * Draft to approved. Under the row lock, the stored definition must pass the
   * validator now (a draft restored from a backup can be `{}`) and every
   * category it names must still be the user's. Approving an approved parser is
   * a no-op. With `expectedRevision` the approval is of the version the person
   * read, not of an edit that landed since.
   */
  async approve(
    userId: string,
    id: string,
    dto: ApproveEmailReceiptParserDto = {},
  ): Promise<EmailReceiptParserView> {
    const row = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      const existing = await this.lockParser(m, userId, id);
      if (
        dto.expectedRevision !== undefined &&
        existing.revision !== dto.expectedRevision
      ) {
        throw revisionConflict();
      }
      if (existing.status === "approved") return existing;
      const definition = validDefinition(existing.definition);
      await assertParserReferencesOwned(m, userId, {
        payeeId: existing.payeeId,
        categoryIds: collectParserCategoryIds(definition),
      });
      await repo.update(
        { id, userId },
        {
          status: "approved",
          approvedAt: new Date(),
          revision: () => "revision + 1",
        },
      );
      return repo.findOneByOrFail({ id, userId });
    });
    return toParserView(row);
  }

  /**
   * Read a stored email with a definition that is not saved, and show what the
   * matcher would do with the result. Reads only: nothing is written.
   */
  async test(
    userId: string,
    dto: TestEmailReceiptParserDto,
  ): Promise<EmailReceiptParserTestResult> {
    const definition = validDefinition(dto.definition);
    return withScopedDb(this.dataSource, async (m) => {
      const receipt = await m.getRepository(EmailReceipt).findOne({
        where: { id: dto.receiptId, userId },
      });
      if (!receipt) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.receiptNotFound",
            `Email ${dto.receiptId} not found`,
            { id: dto.receiptId },
          ),
        );
      }
      const payee = dto.payeeId
        ? await m.getRepository(Payee).findOne({
            where: { id: dto.payeeId, userId },
            select: { id: true, defaultCategoryId: true },
          })
        : null;
      if (dto.payeeId && !payee) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.parserPayeeNotFound",
            "The payee of this parser was not found.",
          ),
        );
      }
      const parsed = parseReceipt(
        definition,
        receipt.subject,
        receipt.bodyText,
        payee?.defaultCategoryId ?? null,
      );
      const receivedDate = receipt.receivedAt.toISOString().slice(0, 10);
      const candidates = await loadReceiptCandidates(
        m,
        userId,
        receivedDate,
        receipt.id,
      );
      const match = matchReceipt(
        parsed,
        receivedDate,
        candidates,
        payee?.id ?? null,
      );
      const hit =
        match.kind === "matched"
          ? candidates.find((c) => c.id === match.transactionId)
          : undefined;
      return {
        parsed,
        match,
        candidateCount: candidates.length,
        transaction: hit
          ? {
              id: hit.id,
              date: hit.transactionDate,
              amount: hit.amount,
              payeeName: hit.payeeName,
            }
          : null,
      };
    });
  }

  private async lockParser(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceiptParser> {
    const row = await m.getRepository(EmailReceiptParser).findOne({
      where: { id, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!row) throw parserNotFound(id);
    return row;
  }
}

/** The definition, or the 400 that lists every code the validator found. Never throws otherwise. */
function validDefinition(input: unknown): ReceiptParserDefinition {
  const validation = validateReceiptParserDefinition(input);
  if (!validation.ok) throw invalidDefinitionError(validation.errors);
  return validation.definition;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

function parserNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.emailReceipts.parserNotFound",
      `Receipt parser ${id} not found`,
      { id },
    ),
  );
}

function revisionConflict(): ConflictException {
  return new ConflictException(
    tr(
      "errors.emailReceipts.parserRevisionConflict",
      "This parser was changed since you opened it. Reload it and try again.",
    ),
  );
}
