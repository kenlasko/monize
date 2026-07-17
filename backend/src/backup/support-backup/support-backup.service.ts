import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";
import { BackupService } from "../backup.service";
import { encryptBackup } from "../backup-crypto.util";
import { applyJsonbHandler } from "./support-backup-jsonb";
import { scopeToAccounts, TableMap } from "./support-backup-scope";
import { maskText, scaleMoney, scaleQuantity } from "./support-backup.util";
import {
  ALWAYS_EXCLUDED_TABLES,
  ColumnRule,
  RULES,
  SECTION_FK_CLEANUP,
  SECTION_TABLES,
  SupportBackupSection,
} from "./support-backup-rules";

const ALL_SECTIONS = Object.keys(SECTION_TABLES) as SupportBackupSection[];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reverse map: table -> the section that owns it (undefined = always-in core). */
const TABLE_SECTION = new Map<string, SupportBackupSection>();
for (const section of ALL_SECTIONS) {
  for (const table of SECTION_TABLES[section])
    TABLE_SECTION.set(table, section);
}

export interface SupportBackupOptions {
  multiplier: number;
  sections?: SupportBackupSection[];
  accountIds?: string[];
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
 * This protects against casual exposure, not a determined party who already
 * knows the user -- dates, frequencies and structure survive by design so bugs
 * still reproduce.
 */
@Injectable()
export class SupportBackupService {
  constructor(private readonly backupService: BackupService) {}

  async generate(
    userId: string,
    options: SupportBackupOptions,
  ): Promise<{ buffer: Buffer; encrypted: boolean }> {
    const raw = await this.backupService.collectRawExport(userId);
    const sections = this.resolveSections(options.sections);
    const obfuscated = this.buildObfuscated(raw.tables, sections, options);
    const remapped = this.remapIdentifiers(obfuscated, userId);

    const payload: Record<string, unknown> = {
      version: raw.version,
      exportedAt: raw.exportedAt,
      supportBackup: true,
      sections,
      ...remapped,
    };
    const gzipped = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
    return options.password
      ? { buffer: encryptBackup(gzipped, options.password), encrypted: true }
      : { buffer: gzipped, encrypted: false };
  }

  async preview(
    userId: string,
    options: SupportBackupOptions,
  ): Promise<{ samples: SupportBackupPreviewSample[] }> {
    const raw = await this.backupService.collectRawExport(userId);
    const sections = this.resolveSections(options.sections);
    const scoped = this.scopeAndSection(raw.tables, sections, options);
    const obfuscated = this.buildObfuscated(raw.tables, sections, options);

    const samples = PREVIEW_TABLES.filter(
      (t) => (scoped[t]?.length ?? 0) > 0,
    ).map((table) => ({
      table,
      before: (scoped[table] ?? []).slice(0, PREVIEW_ROWS),
      after: (obfuscated[table] ?? []).slice(0, PREVIEW_ROWS),
    }));
    return { samples };
  }

  private resolveSections(
    requested?: SupportBackupSection[],
  ): SupportBackupSection[] {
    if (!requested) return [...ALL_SECTIONS];
    return ALL_SECTIONS.filter((s) => requested.includes(s));
  }

  /** Applies account scope (if any) then drops disabled-section tables. */
  private scopeAndSection(
    rawTables: Record<string, Record<string, unknown>[]>,
    sections: SupportBackupSection[],
    options: SupportBackupOptions,
  ): TableMap {
    let tables: TableMap = { ...rawTables };
    if (options.accountIds && options.accountIds.length > 0) {
      tables = scopeToAccounts(tables, options.accountIds);
    }

    const disabled = ALL_SECTIONS.filter((s) => !sections.includes(s));
    for (const section of disabled) {
      for (const table of SECTION_TABLES[section]) delete tables[table];
      for (const { table, column, resetTo } of SECTION_FK_CLEANUP[section]) {
        if (!tables[table]) continue;
        tables[table] = tables[table].map((row) => ({
          ...row,
          [column]: resetTo,
        }));
      }
    }
    for (const table of ALWAYS_EXCLUDED_TABLES) delete tables[table];
    return tables;
  }

  /** Full obfuscation without id remap: scope + sections + rules + reconcile. */
  private buildObfuscated(
    rawTables: Record<string, Record<string, unknown>[]>,
    sections: SupportBackupSection[],
    options: SupportBackupOptions,
  ): TableMap {
    const scoped = this.scopeAndSection(rawTables, sections, options);
    const result: TableMap = {};
    for (const [table, rows] of Object.entries(scoped)) {
      const rules = RULES[table];
      if (!rules) continue; // unclassified table: never emitted (allowlist)
      result[table] = rows.map((row) =>
        this.applyRules(row, rules, options.multiplier),
      );
    }
    this.reconcile(result, options.multiplier);
    return result;
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
   * the sum of its scaled transaction amounts. Integer arithmetic (units of
   * 1e-4) avoids floating-point accumulation.
   */
  private reconcile(tables: TableMap, _multiplier: number): void {
    const UNIT = 10000;
    const toUnits = (value: unknown): number => {
      const num = typeof value === "number" ? value : Number(value);
      return Number.isFinite(num) ? Math.round(num * UNIT) : 0;
    };

    // Split parents = sum of their scaled splits.
    const splitSum = new Map<string, number>();
    for (const split of tables.transaction_splits ?? []) {
      const txId = String(split.transaction_id);
      splitSum.set(txId, (splitSum.get(txId) ?? 0) + toUnits(split.amount));
    }
    for (const tx of tables.transactions ?? []) {
      if (tx.is_split && splitSum.has(String(tx.id))) {
        tx.amount = splitSum.get(String(tx.id))! / UNIT;
      }
    }

    // Account balance = scaled opening + sum of scaled transaction amounts.
    const txSum = new Map<string, number>();
    for (const tx of tables.transactions ?? []) {
      const acc = String(tx.account_id);
      txSum.set(acc, (txSum.get(acc) ?? 0) + toUnits(tx.amount));
    }
    for (const account of tables.accounts ?? []) {
      const opening = toUnits(account.opening_balance);
      const moves = txSum.get(String(account.id)) ?? 0;
      account.current_balance = (opening + moves) / UNIT;
    }
  }

  /**
   * Rewrites every row-id UUID (and the user's own id) to a fresh value, so a
   * shared file can't be correlated with the user's account or with another
   * shared file. FK columns, UUID arrays and ids embedded in JSON are rewritten
   * too, since they are the same UUID strings.
   */
  private remapIdentifiers(tables: TableMap, userId: string): TableMap {
    const remap = new Map<string, string>();
    remap.set(userId, randomUUID());
    for (const rows of Object.values(tables)) {
      for (const row of rows) {
        const id = row.id;
        if (typeof id === "string" && UUID_REGEX.test(id) && !remap.has(id)) {
          remap.set(id, randomUUID());
        }
      }
    }
    const result: TableMap = {};
    for (const [table, rows] of Object.entries(tables)) {
      result[table] = rows.map(
        (row) => this.deepRemap(row, remap) as Record<string, unknown>,
      );
    }
    return result;
  }

  private deepRemap(value: unknown, remap: Map<string, string>): unknown {
    if (typeof value === "string") {
      return remap.get(value) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deepRemap(item, remap));
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date)
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.deepRemap(v, remap)]),
      );
    }
    return value;
  }
}
