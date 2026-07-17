import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";
import { BackupService } from "../backup.service";
import { encryptBackup } from "../backup-crypto.util";
import { applyJsonbHandler } from "./support-backup-jsonb";
import { collectRowIdRemap, deepRemapIds } from "../backup-id-remap.util";
import {
  dedupeMaskedText,
  scrubDanglingRefs,
} from "./support-backup-integrity";
import {
  applyDateRange,
  countsTowardBalance,
  scopeToAccounts,
  TableMap,
} from "./support-backup-scope";
import { maskText, scaleMoney, scaleQuantity } from "./support-backup.util";
import {
  ALWAYS_EXCLUDED_TABLES,
  ColumnRule,
  RULES,
  SECTION_NONFK_CLEANUP,
  SECTION_TABLES,
  SupportBackupSection,
} from "./support-backup-rules";

const ALL_SECTIONS = Object.keys(SECTION_TABLES) as SupportBackupSection[];

/** How long a collected raw export is reused across preview/generate calls.
 *  A support snapshot being up to this stale is harmless, and it turns the
 *  typical tweak-preview-preview-generate flow into a single full dump. */
const RAW_EXPORT_TTL_MS = 60_000;

interface RawExport {
  version: number;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface SupportBackupOptions {
  multiplier: number;
  sections?: SupportBackupSection[];
  accountIds?: string[];
  /** Inclusive yyyy-MM-dd bounds on transaction/price/balance history. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Whether to include the securities price history. Off by default: a full
   * OHLCV series matches public market data exactly and can identify a
   * masked ticker, undoing the symbol masking. Opt in when the bug being
   * reproduced concerns prices or valuations.
   */
  includePriceHistory?: boolean;
  password?: string;
}

export interface SupportBackupPreviewSample {
  table: string;
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

const PREVIEW_TABLES = ["transactions", "accounts", "payees"];
const PREVIEW_ROWS = 5;

/**
 * Produces a de-identified copy of a user's backup for sharing with a
 * maintainer: free text is masked or dropped, private amounts are multiplied by
 * a single hidden factor while public rates/prices are left intact, every
 * identifier is remapped, and the file is otherwise a normal restorable backup.
 * This protects against casual/opportunistic exposure, not a determined party
 * who already knows the user -- dates, frequencies and structure survive by
 * design so bugs still reproduce.
 */
@Injectable()
export class SupportBackupService {
  constructor(private readonly backupService: BackupService) {}

  /** Short-lived per-user cache of the raw export (the dump does not depend on
   *  any option), so preview and the eventual generate reuse one collection. */
  private readonly rawCache = new Map<
    string,
    { expires: number; promise: Promise<RawExport> }
  >();

  private collectRawExport(userId: string): Promise<RawExport> {
    const now = Date.now();
    for (const [key, entry] of this.rawCache) {
      if (entry.expires <= now) this.rawCache.delete(key);
    }
    const cached = this.rawCache.get(userId);
    if (cached && cached.expires > now) return cached.promise;

    const promise = this.backupService.collectRawExport(userId);
    this.rawCache.set(userId, { expires: now + RAW_EXPORT_TTL_MS, promise });
    // A failed dump must not be cached as a poisoned promise.
    promise.catch(() => this.rawCache.delete(userId));
    return promise;
  }

  async generate(
    userId: string,
    options: SupportBackupOptions,
  ): Promise<{ buffer: Buffer; encrypted: boolean }> {
    const raw = await this.collectRawExport(userId);
    const sections = this.resolveSections(options.sections);
    const scoped = this.scopeAndSection(raw.tables, sections, options);
    const obfuscated = this.obfuscate(scoped, options.multiplier);
    const remapped = this.remapIdentifiers(obfuscated, userId);

    const payload: Record<string, unknown> = {
      version: raw.version,
      exportedAt: raw.exportedAt,
      supportBackup: true,
      sections,
      ...remapped,
    };
    const gzipped = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
    // encryptBackup derives its AES-256-GCM key from the user's password
    // (scrypt), not from AI_ENCRYPTION_KEY, so a support backup encrypts fine
    // regardless of whether that env var is configured.
    return options.password
      ? { buffer: encryptBackup(gzipped, options.password), encrypted: true }
      : { buffer: gzipped, encrypted: false };
  }

  async preview(
    userId: string,
    options: SupportBackupOptions,
  ): Promise<{ samples: SupportBackupPreviewSample[] }> {
    const raw = await this.collectRawExport(userId);
    const sections = this.resolveSections(options.sections);
    const scoped = this.scopeAndSection(raw.tables, sections, options);
    // The preview shows a handful of rows from a few tables. Narrow the scoped
    // map to just those rows (plus what reconciliation needs to keep the shown
    // accounts' balances and split parents exact) before obfuscating, so a
    // huge ledger isn't rule-rewritten to display five rows.
    const previewInput = this.slicePreviewInput(scoped);
    const obfuscated = this.obfuscate(previewInput, options.multiplier);

    const samples = PREVIEW_TABLES.filter(
      (t) => (previewInput[t]?.length ?? 0) > 0,
    ).map((table) => ({
      table,
      before: (previewInput[table] ?? []).slice(0, PREVIEW_ROWS),
      after: (obfuscated[table] ?? []).slice(0, PREVIEW_ROWS),
    }));
    return { samples };
  }

  /**
   * Reduces a scoped map to the minimum the preview needs: the shown accounts'
   * full ledgers (so their reconciled balances stay exact) plus the shown
   * transactions and payees, and the splits of the kept transactions (so
   * split-parent amounts stay exact). Everything else is dropped.
   */
  private slicePreviewInput(scoped: TableMap): TableMap {
    const accounts = (scoped.accounts ?? []).slice(0, PREVIEW_ROWS);
    const accountIds = new Set(accounts.map((a) => String(a.id)));
    const allTx = scoped.transactions ?? [];
    const shownTx = allTx.slice(0, PREVIEW_ROWS);
    const shownTxIds = new Set(shownTx.map((t) => String(t.id)));
    const transactions = allTx.filter(
      (t) =>
        accountIds.has(String(t.account_id)) || shownTxIds.has(String(t.id)),
    );
    const keptTxIds = new Set(transactions.map((t) => String(t.id)));
    const transaction_splits = (scoped.transaction_splits ?? []).filter((s) =>
      keptTxIds.has(String(s.transaction_id)),
    );
    return {
      accounts,
      transactions,
      transaction_splits,
      payees: (scoped.payees ?? []).slice(0, PREVIEW_ROWS),
    };
  }

  private resolveSections(
    requested?: SupportBackupSection[],
  ): SupportBackupSection[] {
    if (!requested) return [...ALL_SECTIONS];
    return ALL_SECTIONS.filter((s) => requested.includes(s));
  }

  /**
   * Trims the raw export to the requested date range, account scope and
   * sections, then repairs every reference the trimming severed so the file
   * stays restorable.
   */
  private scopeAndSection(
    rawTables: Record<string, Record<string, unknown>[]>,
    sections: SupportBackupSection[],
    options: SupportBackupOptions,
  ): TableMap {
    // applyDateRange owns the defensive copy of the raw export (it always
    // returns a fresh top-level map), so the deletes/maps below never touch
    // BackupService's collected data.
    const tables = applyDateRange(rawTables, options.dateFrom, options.dateTo);
    const trimmedByDate = !!(options.dateFrom || options.dateTo);
    if (options.accountIds && options.accountIds.length > 0) {
      Object.assign(tables, scopeToAccounts(tables, options.accountIds));
    }
    const scopedByAccount = !!(options.accountIds && options.accountIds.length);

    const disabled = ALL_SECTIONS.filter((s) => !sections.includes(s));
    for (const section of disabled) {
      for (const table of SECTION_TABLES[section]) delete tables[table];
      for (const { table, column, resetTo } of SECTION_NONFK_CLEANUP[section] ??
        []) {
        if (!tables[table]) continue;
        tables[table] = tables[table].map((row) => ({
          ...row,
          [column]: resetTo,
        }));
      }
    }
    for (const table of ALWAYS_EXCLUDED_TABLES) delete tables[table];
    if (!options.includePriceHistory) delete tables.security_prices;

    // The scrub only has work to do when trimming could have severed an FK.
    // A full export (all sections, no date range, no account scope) is closed
    // by the live FK constraints -- the only removals (ai_provider_configs,
    // security_prices) are targets of no exported FK -- so skip it.
    const couldDangle = trimmedByDate || scopedByAccount || disabled.length > 0;
    return couldDangle ? scrubDanglingRefs(tables) : tables;
  }

  /** Applies the per-column rules and reconciles derived money. */
  private obfuscate(scoped: TableMap, multiplier: number): TableMap {
    const result: TableMap = {};
    for (const [table, rows] of Object.entries(scoped)) {
      const rules = RULES[table];
      if (!rules) continue; // unclassified table: never emitted (allowlist)
      result[table] = rows.map((row) =>
        this.applyRules(row, rules, multiplier),
      );
    }
    // Masking can collapse distinct values to the same string; restore uniqueness
    // on UNIQUE columns before reconciling so no row is later dropped on insert.
    return this.reconcile(dedupeMaskedText(result));
  }

  private applyRules(
    row: Record<string, unknown>,
    rules: Record<string, ColumnRule>,
    multiplier: number,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      const rule = rules[column];
      if (!rule) continue; // unclassified column: dropped (allowlist)
      out[column] = this.applyRule(rule, value, multiplier);
    }
    return out;
  }

  private applyRule(
    rule: ColumnRule,
    value: unknown,
    multiplier: number,
  ): unknown {
    switch (rule.t) {
      case "keep":
        return value;
      case "mask":
        return maskText(value);
      case "drop":
        return null;
      case "const":
        return rule.value;
      case "scale":
        return scaleMoney(value, multiplier);
      case "scaleQty":
        return scaleQuantity(value, multiplier);
      case "jsonb":
        return applyJsonbHandler(rule.handler, value, multiplier);
    }
  }

  /**
   * Recomputes derived money from the already-scaled values so nothing drifts:
   * a split transaction's amount becomes the exact sum of its scaled splits,
   * and each account's current balance becomes its scaled opening balance plus
   * the sum of its scaled transaction amounts -- counting only the rows the
   * app itself counts (VOID transactions and legacy split-child rows are
   * excluded, mirroring the balance guards in the transactions domain).
   * Integer arithmetic (units of 1e-4) avoids floating-point accumulation.
   * Returns new row objects; the input map is not mutated.
   */
  private reconcile(tables: TableMap): TableMap {
    const UNIT = 10000;
    const toUnits = (value: unknown): number => {
      const num = typeof value === "number" ? value : Number(value);
      return Number.isFinite(num) ? Math.round(num * UNIT) : 0;
    };

    const splitSum = new Map<string, number>();
    for (const split of tables.transaction_splits ?? []) {
      const txId = String(split.transaction_id);
      splitSum.set(txId, (splitSum.get(txId) ?? 0) + toUnits(split.amount));
    }

    const txSum = new Map<string, number>();
    const transactions = (tables.transactions ?? []).map((tx) => {
      const withSplits =
        tx.is_split && splitSum.has(String(tx.id))
          ? { ...tx, amount: splitSum.get(String(tx.id))! / UNIT }
          : tx;
      if (countsTowardBalance(withSplits)) {
        const account = String(withSplits.account_id);
        txSum.set(
          account,
          (txSum.get(account) ?? 0) + toUnits(withSplits.amount),
        );
      }
      return withSplits;
    });

    const accounts = (tables.accounts ?? []).map((account) => {
      const opening = toUnits(account.opening_balance);
      const moves = txSum.get(String(account.id)) ?? 0;
      return { ...account, current_balance: (opening + moves) / UNIT };
    });

    return {
      ...tables,
      ...(tables.transactions ? { transactions } : {}),
      ...(tables.accounts ? { accounts } : {}),
    };
  }

  /**
   * Rewrites every row-id UUID (and the user's own id) to a fresh value, so a
   * shared file can't be correlated with the user's account or with another
   * shared file. FK columns, UUID arrays and ids embedded in JSON are rewritten
   * too, since they are the same UUID strings.
   */
  private remapIdentifiers(tables: TableMap, userId: string): TableMap {
    const remap = new Map<string, string>();
    // Unlike the restore-side remap, the user's own id is remapped too (it is
    // never rescoped here) and currencies need no exception: their rows carry
    // no `id` column, so the shared collector skips them naturally.
    remap.set(userId, randomUUID());
    for (const rows of Object.values(tables)) {
      collectRowIdRemap(rows, remap, randomUUID);
    }
    const result: TableMap = {};
    for (const [table, rows] of Object.entries(tables)) {
      result[table] = rows.map(
        (row) => deepRemapIds(row, remap) as Record<string, unknown>,
      );
    }
    return result;
  }
}
