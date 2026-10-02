import { ConflictException, Injectable } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { DataSource, EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { withScopedDb } from "../common/db/scoped-db";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { tr } from "../i18n/translate";
import { PayeeAlias } from "../payees/entities/payee-alias.entity";
import { PayeesService } from "../payees/payees.service";
import {
  emptyImportPreviewLabels,
  matchedRuleViews,
  mergeImportPreviewLabels,
} from "../import-preview/rule-trace";
import {
  matchedAliasPattern,
  reportPayeeResolution,
} from "../import-preview/payee-resolution";
import type { RuleEffects } from "../transaction-rules/rule-effects";
import type { RuleEffectsLabels } from "../transaction-rules/transaction-rules-applier.service";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import { TransactionStatus } from "../transactions/entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { operationTagLabel } from "./bank-operation";
import { findTagId } from "./bank-sync-operation-tags";
import type { BankSyncProfile } from "./bank-sync-profiles";
import {
  findExistingPayee,
  NO_PAYEE,
  type ResolvedPayee,
} from "./bank-sync-payee-lookup";
import {
  findLedgerEntries,
  newPlannedRows,
  planFingerprint,
} from "./bank-sync-plan-fingerprint";
import type { NormalizedBankBalance } from "./bank-sync-writer.service";
import type {
  BankSyncPreviewLabels,
  BankSyncPreviewRowView,
  BankSyncPreviewView,
} from "./bank-sync.types";
import type {
  ExplainedBankImport,
  PlanEntry,
} from "./bank-transaction-planner";
import type { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";

export interface BuildBankSyncPreviewInput {
  userId: string;
  bankAccountId: string;
  /** The Monize account the sync read for. */
  accountId: string;
  /** The cut-off the plan was made against (as read at step 1); null when none. */
  plannedSyncFromDate: string | null;
  /** The account currency the plan was made against. */
  plannedCurrencyCode: string;
  explained: ExplainedBankImport;
  balance: NormalizedBankBalance | null;
  /** The connection's `tag_operation_type`: whether the preview shows the operation-type tag. */
  tagOperationType: boolean;
  /**
   * The profile of the connection's institution, resolved once for the preview
   * (`resolveProfile`); the sync resolves the same one, so the tag shown is the
   * tag written.
   */
  profile: BankSyncProfile;
}

/** What one preview needs at every `new` row, read once. */
interface RowContext {
  m: EntityManager;
  userId: string;
  account: Account;
  /** The `import` rules, loaded once for the whole preview. */
  rules: readonly TransactionRule[];
  /** The operation-type tag's translator; null when the connection does not tag. */
  t: ReturnType<typeof emailTranslator> | null;
  /** The institution's profile, which names the operation-type tag. */
  profile: BankSyncProfile;
  payeeCache: Map<string, ResolvedPayee | null>;
  /** The id of an existing tag by lower-cased name; null when there is none. */
  tagIds: Map<string, string | null>;
  labels: BankSyncPreviewLabels;
  /** The user's aliases, read the first time a row resolves through one. */
  aliases: () => Promise<PayeeAlias[]>;
}

/** Scaled integer of a money value at the column's four decimals. */
const toUnits = (value: number): number => Math.round(value * 10000);
const fromUnits = (units: number): string => (units / 10000).toFixed(4);

/**
 * The read-only half of step 5 of a sync (docs/specs/bank-sync.md section 7a).
 *
 * It is handed the same `ExplainedBankImport` a sync plans from, so the rows,
 * keys and amounts are the planner's own; it asks the ledger which keys exist
 * (`findLedgerKeys`, the question the sync's fingerprint check asks), resolves the
 * payee through the lookup the writer uses (`findExistingPayee`) and plans the
 * `import` rules through `TransactionRulesApplierService.previewForRow`, the
 * planning path `applyToNew` shares. Nothing is inserted, updated or locked: a
 * preview that wrote would not be a preview.
 *
 * The balance after the import is the current balance plus the sum of the `new`
 * rows, added as scaled integers.
 *
 * **The details of spec section 7b.** The `import` rules are loaded once and
 * planned per row through `planForRow`, the planning path `applyToNew` shares;
 * the operation-type tag is given to the rules as the writer gives it (before
 * them), so a rule that reads the tag sees what it would see at the commit. Each
 * `new` row reports how its payee resolves and the trace of every rule that
 * matched; an exception is told apart from an imported row.
 */
@Injectable()
export class BankSyncPreviewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rulesApplier: TransactionRulesApplierService,
    private readonly payeesService: PayeesService,
    private readonly i18n: I18nService,
  ) {}

  async build(input: BuildBankSyncPreviewInput): Promise<BankSyncPreviewView> {
    const { userId, bankAccountId, accountId, explained } = input;
    const { plan, entries } = explained;

    return withScopedDb(this.dataSource, async (m) => {
      // The read the plan stands on must still describe the link: a re-link or a
      // new cut-off during the fetch makes the listing someone else's.
      const link = await m
        .getRepository(BankSyncAccount)
        .findOne({ where: { id: bankAccountId, userId } });
      const account = await m
        .getRepository(Account)
        .findOne({ where: { id: accountId, userId } });
      if (!link || link.accountId !== accountId || !account) {
        throw new ConflictException(
          tr(
            "errors.bankSync.linkChanged",
            "The bank account was linked to a different account while it was being read. Nothing was imported; sync again.",
          ),
        );
      }
      if (link.syncFromDate !== input.plannedSyncFromDate) {
        throw new ConflictException(
          tr(
            "errors.bankSync.cutoffChanged",
            "The cut-off date of the bank account changed while it was being read. Nothing was imported; sync again.",
          ),
        );
      }
      const currencyCode = account.currencyCode.trim().toUpperCase();
      if (currencyCode !== input.plannedCurrencyCode.trim().toUpperCase()) {
        throw new ConflictException(
          tr(
            "errors.bankSync.accountCurrencyChanged",
            "The currency of the linked account changed while it was being read. Nothing was imported; sync again.",
          ),
        );
      }

      const ledger = await findLedgerEntries(
        m,
        userId,
        accountId,
        plan.planned.map((row) => row.externalKey),
      );
      const ledgerKeys = new Set(ledger.keys());
      const newRows = newPlannedRows(plan.planned, ledgerKeys);

      // Rules are read once for the whole preview.
      const labels = emptyImportPreviewLabels();
      let aliases: Promise<PayeeAlias[]> | null = null;
      const context: RowContext = {
        m,
        userId,
        account,
        rules: await this.rulesApplier.loadRulesFor(m, userId, "import"),
        t: input.tagOperationType
          ? emailTranslator(
              this.i18n,
              await resolveUserEmailLocale(
                m.getRepository(UserPreference),
                userId,
              ),
            )
          : null,
        profile: input.profile,
        payeeCache: new Map(),
        tagIds: new Map(),
        labels,
        aliases: () => (aliases ??= this.payeesService.getAllAliases(userId)),
      };

      const rows: BankSyncPreviewRowView[] = [];
      let excluded = 0;
      for (const entry of entries) {
        if (entry.outcome !== "planned") {
          rows.push(this.plainRow(entry, entry.outcome));
          continue;
        }
        const held = ledger.get(entry.externalKey as string);
        if (held === undefined) {
          rows.push(await this.newRow(context, entry));
        } else if (held.excluded) {
          excluded += 1;
          rows.push(this.plainRow(entry, "excluded"));
        } else {
          rows.push(this.plainRow(entry, "duplicate"));
        }
      }

      const refused = Object.values(plan.refused).reduce(
        (sum, count) => sum + count,
        0,
      );
      const newUnits = newRows.reduce(
        (sum, row) => sum + toUnits(row.amount),
        0,
      );
      const monizeUnits = toUnits(Number(account.currentBalance));
      const afterUnits = monizeUnits + newUnits;
      const bank = input.balance;
      const comparable =
        bank !== null && bank.currencyCode.toUpperCase() === currencyCode;

      return {
        bankAccountId,
        currencyCode,
        rows,
        labels,
        summary: {
          new: newRows.length,
          duplicate: plan.planned.length - newRows.length - excluded,
          excluded,
          refused,
          refusedByReason: plan.refused,
          pending: plan.pending,
          beforeCutoff: plan.beforeCutoff,
        },
        monizeBalance: fromUnits(monizeUnits),
        balanceAfter: fromUnits(afterUnits),
        bankBalance:
          bank === null
            ? null
            : {
                amount: bank.amount.toFixed(4),
                currencyCode: bank.currencyCode,
                referenceDate: bank.referenceDate,
              },
        difference: comparable
          ? fromUnits(toUnits(bank.amount) - afterUnits)
          : null,
        planFingerprint: planFingerprint(newRows),
      };
    });
  }

  /** A row with nothing resolved: duplicate, exception, refused, pending or before the cut-off. */
  private plainRow(
    entry: PlanEntry,
    outcome: BankSyncPreviewRowView["outcome"],
  ): BankSyncPreviewRowView {
    return {
      outcome,
      externalKey: entry.externalKey,
      refusalReason: entry.reason,
      transactionDate: entry.transactionDate,
      amount: entry.amount === null ? null : entry.amount.toFixed(4),
      currencyCode: entry.currencyCode,
      payeeText: entry.payeeText,
      description: entry.description,
      referenceNumber: entry.referenceNumber,
      payeeName: null,
      categoryName: null,
      tagNames: [],
      payee: null,
      rules: [],
      operationTag: null,
    };
  }

  /**
   * A row the sync would write: the payee its counterparty resolves to (or the
   * counterparty's own text when the payee would be created), the payee's
   * default category, the operation-type tag, and what the `import` rules change
   * on top, with how the payee was found and which rules matched.
   */
  private async newRow(
    context: RowContext,
    entry: PlanEntry,
  ): Promise<BankSyncPreviewRowView> {
    const { m, userId, account } = context;
    const payee = await this.lookUpPayee(context, entry.payeeText);
    let payeeName = payee?.payeeName ?? entry.payeeText;
    let categoryId = payee?.defaultCategoryId ?? null;
    let categoryName = payee?.defaultCategoryName ?? null;

    // The operation-type tag goes on before the rules run (as the writer does),
    // so the rules are planned over a row that already carries it. A tag that
    // does not exist yet has no id for a rule to name, so the row's tag set
    // stays empty until the commit creates it.
    const operationTag =
      context.t === null
        ? null
        : operationTagLabel(
            entry.operation,
            context.profile,
            context.t,
            entry.direction,
          );
    const operationTagId =
      operationTag === null
        ? null
        : await this.tagId(context, operationTag.label);

    const effects: RuleEffects | null =
      context.rules.length > 0
        ? await this.rulesApplier.planForRow(
            m,
            userId,
            {
              accountId: account.id,
              currencyCode: account.currencyCode,
              amount: entry.amount,
              isTransfer: false,
              payeeId: payee?.payeeId ?? null,
              payeeText: entry.payeeText,
              payeeName,
              categoryId,
              description: entry.description,
              tagIds: operationTagId === null ? [] : [operationTagId],
              hasSplits: false,
              referenceNumber: entry.referenceNumber,
              transactionDate: entry.transactionDate,
              status: TransactionStatus.CLEARED,
              hasAttachment: false,
            },
            context.rules,
          )
        : null;
    const trace = effects?.trace ?? [];
    const labels: RuleEffectsLabels | null =
      effects !== null && trace.some((traced) => traced.matched)
        ? await this.rulesApplier.labelsFor(m, userId, effects, context.rules)
        : null;
    if (labels !== null) mergeImportPreviewLabels(context.labels, labels);

    // How the payee was found: an existing payee by name or alias (the alias
    // pattern is looked up among the user's aliases, read once per preview).
    const found =
      payee !== null && payee.via !== null && payee.payeeId !== null
        ? { payeeId: payee.payeeId, via: payee.via }
        : null;
    const aliasPattern =
      found?.via === "alias" && entry.payeeText !== null
        ? matchedAliasPattern(
            await context.aliases(),
            found.payeeId,
            entry.payeeText,
          )
        : null;
    let rulePayee: { payeeId: string | null } | null = null;

    const tagNames: string[] =
      operationTag === null ? [] : [operationTag.label];
    if (effects !== null && labels !== null) {
      const { changes } = effects;
      if (changes.createPayee !== undefined) {
        payeeName = changes.createPayee;
        rulePayee = { payeeId: null };
      } else if (changes.payeeId !== undefined) {
        payeeName =
          changes.payeeId === null
            ? null
            : (changes.payeeName ??
              labels.payees[changes.payeeId] ??
              payeeName);
        rulePayee = { payeeId: changes.payeeId };
      }
      if (changes.categoryId !== undefined) {
        categoryId = changes.categoryId;
        categoryName =
          changes.categoryId === null
            ? null
            : (labels.categories[changes.categoryId] ?? null);
      }
      const removed = new Set(changes.removeTagIds);
      if (operationTagId !== null && removed.has(operationTagId)) {
        tagNames.length = 0;
      }
      for (const id of changes.addTagIds) {
        const name = labels.tags[id];
        if (
          name !== undefined &&
          !removed.has(id) &&
          !tagNames.some((known) => known.toLowerCase() === name.toLowerCase())
        ) {
          tagNames.push(name);
        }
      }
    }

    return {
      ...this.plainRow(entry, "new"),
      payeeName,
      categoryName: categoryId === null ? null : categoryName,
      tagNames,
      payee: reportPayeeResolution({
        original: entry.payeeText,
        name: payeeName,
        found,
        aliasPattern,
        rule: rulePayee,
      }),
      rules: matchedRuleViews(trace, labels?.rules ?? null),
      operationTag: operationTag?.label ?? null,
    };
  }

  /** The id of the user's tag called `name` if there is one; never creates (a preview writes nothing). */
  private async tagId(
    context: RowContext,
    name: string,
  ): Promise<string | null> {
    const key = name.toLowerCase();
    if (context.tagIds.has(key)) return context.tagIds.get(key) ?? null;
    const id = await findTagId(context.m, context.userId, name);
    context.tagIds.set(key, id);
    return id;
  }

  private async lookUpPayee(
    context: RowContext,
    text: string | null,
  ): Promise<ResolvedPayee | null> {
    if (text === null) return NO_PAYEE;
    if (context.payeeCache.has(text))
      return context.payeeCache.get(text) ?? null;
    const found = await findExistingPayee(
      this.payeesService,
      context.userId,
      text,
    );
    context.payeeCache.set(text, found);
    return found;
  }
}
