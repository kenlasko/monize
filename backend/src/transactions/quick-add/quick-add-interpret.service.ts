import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { isTransactionInFuture } from "../../common/date-utils";
import { currentRequestLocale } from "../../i18n/request-locale";
import { tr } from "../../i18n/translate";
import { TransactionsService } from "../transactions.service";
import { TransactionTransferService } from "../transaction-transfer.service";
import {
  QuickAddInterpretDto,
  QuickAddPinsDto,
} from "./dto/quick-add-interpret.dto";
import {
  QuickAddCandidates,
  loadMostRecentAccountId,
  loadOwnedPayee,
  loadPayeeHistory,
  loadQuickAddCandidates,
  loadUsage,
} from "./quick-add-candidates";
import { fillQuickAdd } from "./quick-add-fill.util";
import { resolveQuickAddPayee } from "./quick-add-fill-payee.util";
import {
  EMPTY_PAYEE_HISTORY,
  QuickAddPins,
} from "./quick-add-fill-shared.util";
import { QuickAddReading, readQuickAddText } from "./quick-add-parse.util";
import { resolveQuickAddVocabulary } from "./quick-add-vocabulary";
import type { QuickAddInterpretation, QuickAddKind } from "./quick-add.types";
import type { RuleEffectsPreview } from "../../transaction-rules/transaction-rules-applier.service";

/** A blank optional value (`undefined`, `null`, `""`) is absent. */
function given<T>(value: T | null | undefined | ""): T | undefined {
  return value === null || value === undefined || value === ""
    ? undefined
    : value;
}

/**
 * Reads a Quick Add line (`docs/future-plans/quick-add.md`). Read-only: it
 * loads the candidates through `withScopedDb`, reads the text with the pure
 * reader, fills what was not typed and previews the reader's rules. The save
 * is the ordinary `POST /transactions` or `POST /transactions/transfer`.
 */
@Injectable()
export class QuickAddInterpretService {
  private readonly logger = new Logger(QuickAddInterpretService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactionsService: TransactionsService,
    private readonly transferService: TransactionTransferService,
  ) {}

  async interpret(
    userId: string,
    dto: QuickAddInterpretDto,
  ): Promise<QuickAddInterpretation> {
    const locale = currentRequestLocale();
    const interpretation = await withScopedDb(this.dataSource, async (m) => {
      const candidates = await loadQuickAddCandidates(m, userId);
      const pins = await this.resolvePins(m, userId, dto.pins, candidates);
      const accountsById = new Map(candidates.accounts.map((a) => [a.id, a]));

      const reading = readQuickAddText({
        text: dto.text,
        today: dto.today,
        locale,
        numberFormat: candidates.numberFormat,
        dateFormat: candidates.dateFormat,
        vocabulary: resolveQuickAddVocabulary(locale),
        accounts: candidates.accounts,
        payees: candidates.payees,
        categories: candidates.categories,
        heldCurrencies: candidates.currencies,
        payeePinned: !!(pins.payee || pins.payeeName),
      });

      const payeeUsage = await loadUsage(m, userId, "payee_id", [
        ...(reading.payee?.candidates ?? []).map((p) => p.id),
        ...reading.payeeAlternatives.map((p) => p.id),
      ]);
      const categoryUsage = await loadUsage(m, userId, "category_id", [
        ...(reading.category?.candidates ?? []).map((c) => c.id),
        ...reading.categoryAlternatives.map((c) => c.id),
      ]);
      const accountUsage = await loadUsage(
        m,
        userId,
        "account_id",
        mentionedAccountIds(reading),
      );

      const payee = resolveQuickAddPayee(reading, pins, payeeUsage);
      const history = payee.payee
        ? await loadPayeeHistory(m, userId, payee.payee.id)
        : EMPTY_PAYEE_HISTORY;
      const mostRecentAccountId = await loadMostRecentAccountId(
        m,
        userId,
        candidates.accounts.map((a) => a.id),
      );
      const contextAccountId = given(dto.contextAccountId);

      return fillQuickAdd({
        reading,
        pins,
        payee,
        today: dto.today,
        accounts: accountsById,
        categories: new Map(candidates.categories.map((c) => [c.id, c])),
        contextAccountId:
          contextAccountId && accountsById.has(contextAccountId)
            ? contextAccountId
            : null,
        history,
        mostRecentAccountId,
        accountUsage,
        categoryUsage,
        currencyPlaces: candidates.currencyPlaces,
        isFuture: isTransactionInFuture,
      });
    });
    const ruleEffects = await this.previewRuleEffects(userId, interpretation);
    return ruleEffects ? { ...interpretation, ruleEffects } : interpretation;
  }

  /**
   * The pins with blanks read as absent and every id looked up as the
   * caller's: an account must be one the reader may enter into, a payee and
   * a category their own. Anything else is refused with 404, as
   * `previewCreate` refuses a category, before anything is read from it.
   */
  private async resolvePins(
    m: EntityManager,
    userId: string,
    dto: QuickAddPinsDto | undefined,
    candidates: QuickAddCandidates,
  ): Promise<QuickAddPins> {
    const accountPin = (id: string | undefined) => {
      if (id === undefined) return undefined;
      const account = candidates.accounts.find((a) => a.id === id);
      if (!account) {
        throw new NotFoundException(
          tr("errors.accounts.notFound", "Account not found"),
        );
      }
      return account;
    };
    const payeeId = given(dto?.payeeId);
    const payee = payeeId
      ? (candidates.payees.find((p) => p.id === payeeId) ??
        (await loadOwnedPayee(m, userId, payeeId)))
      : undefined;
    if (payeeId && !payee) {
      throw new NotFoundException(
        tr("errors.transactions.payeeNotFound", "Payee not found"),
      );
    }
    const categoryId = given(dto?.categoryId);
    const category = categoryId
      ? candidates.categories.find((c) => c.id === categoryId)
      : undefined;
    if (categoryId && !category) {
      throw new NotFoundException(
        tr("errors.transactions.categoryNotFound", "Category not found"),
      );
    }
    const payeeName = given(dto?.payeeName?.trim());
    return {
      kind: given<QuickAddKind>(dto?.kind),
      amount: given(dto?.amount),
      date: given(dto?.date),
      account: accountPin(given(dto?.accountId)),
      toAccount: accountPin(given(dto?.toAccountId)),
      payee: payee ?? undefined,
      payeeName: payee ? undefined : payeeName,
      category,
    };
  }

  /**
   * What the reader's rules will do on save, from the planner the commit
   * runs (`previewCreate` / `previewCreateTransfer`), once the entry could be
   * saved as shown. A preview that throws is no `ruleEffects`: the reading
   * itself never fails because a preview did.
   */
  private async previewRuleEffects(
    userId: string,
    reading: QuickAddInterpretation,
  ): Promise<RuleEffectsPreview | undefined> {
    const account = reading.account.value;
    const amount = reading.amount.value;
    const date = reading.date.value;
    if (!account || amount === null || !date || reading.blockers.length > 0) {
      return undefined;
    }
    const payeeName = reading.payee.value?.name;
    const description = reading.memo ?? undefined;
    try {
      if (reading.kind.value === "transfer") {
        const toAccount = reading.toAccount.value;
        if (!toAccount) return undefined;
        const preview = await this.transferService.previewCreateTransfer(
          userId,
          {
            fromAccountId: account.id,
            toAccountId: toAccount.id,
            amount,
            transactionDate: date,
            payeeName,
            description,
          },
        );
        return preview.ruleEffects;
      }
      const preview = await this.transactionsService.previewCreate(userId, {
        accountId: account.id,
        amount: reading.kind.value === "deposit" ? amount : -amount,
        transactionDate: date,
        payeeName,
        categoryId: reading.category.value?.id,
        description,
      });
      return preview.ruleEffects;
    } catch (error) {
      this.logger.debug(
        `Quick Add rule preview skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}

/** The accounts a usage count can rank: every account the text named or could have. */
function mentionedAccountIds(reading: QuickAddReading): string[] {
  return [
    ...reading.accounts.flatMap((m) => m.candidates.map((a) => a.id)),
    ...reading.accountAlternatives.map((a) => a.id),
  ];
}
