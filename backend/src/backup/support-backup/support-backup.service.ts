import { reconcileSharedSupport } from "./support-backup-rules.shared";
import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { randomBytes, randomUUID } from "crypto";
import { gzipSync } from "zlib";
import { BackupService } from "../backup.service";
import { tr } from "../../i18n/translate";
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
import { CURRENCY_METADATA } from "../../currencies/currency-metadata";
import { CURRENCY_REFERENCE_COLUMNS } from "../../currencies/currency-reference-columns";
import {
  ALWAYS_EXCLUDED_TABLES,
  ColumnRule,
  RULES,
  SECTION_NONFK_CLEANUP,
  SECTION_TABLES,
  SupportBackupSection,
} from "./support-backup-rules";

const ALL_SECTIONS = Object.keys(SECTION_TABLES) as SupportBackupSection[];

/** U+00A4, the generic currency sign, for a pseudonymised custom currency. */
const GENERIC_CURRENCY_SYMBOL = "¤";

/**
 * A three-letter code no row in this payload uses and no real currency claims.
 *
 * Random rather than derived from the original: a derived code would let two
 * artifacts from the same user be lined up by it, which is the correlation the
 * whole remapping step exists to prevent.
 *
 * The catalog is consulted here rather than only through `taken`. The caller does
 * seed `taken` with every catalogued code, so the end-to-end path was safe -- but
 * the guarantee in the sentence above was the caller's to keep, and a second
 * caller that seeded only the payload's own codes would have emitted `USD` as a
 * pseudonym with nothing to stop it. `taken` is still needed for the codes this
 * payload uses, which the catalog does not know about.
 *
 * Exported for its own test. The end-to-end path costs two scrypt derivations
 * per export (~200 ms), so probing the allocator's randomness through `generate`
 * bought a handful of samples for seconds of CPU; the wiring and the allocation
 * property are now tested separately, and the second one thoroughly.
 */
const PSEUDONYM_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The largest multiple of 26 that fits in a byte (256 - 256 % 26 = 234).
 *
 * `randomBytes(1)[0] % 26` is *not* uniform: bytes 0-21 map to A-V one more
 * time than 22-25 map to W-Z, so those six letters appear ~9.4% more often
 * (CodeQL `js/biased-cryptographic-random`). Discarding the 22 values at or
 * above this bound leaves an exact multiple of 26 and restores uniformity.
 */
const UNBIASED_BYTE_CEILING = 256 - (256 % PSEUDONYM_LETTERS.length);

/**
 * One uniformly-distributed letter, by rejection sampling.
 *
 * Draws in blocks rather than a byte at a time so the (22/256 ≈ 8.6%) rejection
 * rate costs no extra syscall in practice. Exported for its own distribution
 * test.
 */
export function randomPseudonymLetter(): string {
  for (;;) {
    for (const byte of randomBytes(16)) {
      if (byte < UNBIASED_BYTE_CEILING) {
        return PSEUDONYM_LETTERS[byte % PSEUDONYM_LETTERS.length];
      }
    }
  }
}

export function allocatePseudonymCode(taken: Set<string>): string {
  // 17,576 combinations against a catalog of a few hundred, so this converges
  // immediately; the bound exists so a pathological `taken` cannot spin forever.
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const code = `${randomPseudonymLetter()}${randomPseudonymLetter()}${randomPseudonymLetter()}`;
    if (!taken.has(code) && CURRENCY_METADATA[code] === undefined) {
      taken.add(code);
      return code;
    }
  }
  throw new Error(
    "Could not allocate a pseudonymous currency code: every three-letter combination is taken.",
  );
}

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
  /**
   * Password the produced file is encrypted under (AES-256-GCM).
   *
   * Optional on the shared options type because `preview` takes the same object
   * and produces no file, but `generate` requires it -- see the check there.
   */
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

    // Never query what this artifact always excludes -- `attachment_blobs` above
    // all, which is base64 and can be the largest thing in the database.
    const promise = this.backupService.collectRawExport(userId, {
      skipTables: ALWAYS_EXCLUDED_TABLES,
    });
    this.rawCache.set(userId, { expires: now + RAW_EXPORT_TTL_MS, promise });
    // A failed dump must not be cached as a poisoned promise.
    promise.catch(() => this.rawCache.delete(userId));
    return promise;
  }

  async generate(
    userId: string,
    options: SupportBackupOptions,
  ): Promise<{ buffer: Buffer; encrypted: boolean }> {
    // A support backup is produced in order to leave the user's machine, so it
    // never ships in the clear. `CreateSupportBackupDto` requires a password, so
    // no HTTP caller can reach this -- but the branch that returned plain gzip
    // when `options.password` was absent still existed, and the guarantee lived
    // only at the edge. A future internal caller (a cron, a CLI, an admin path)
    // that forgot the field would have got an unencrypted de-identified dump and
    // no error at all. The producer of the file enforces it now, and the DTO is
    // the second line rather than the only one.
    const password = options.password;
    if (typeof password !== "string" || password.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.backup.supportPasswordRequired",
          "A support backup must be encrypted: supply a password.",
        ),
      );
    }

    const raw = await this.collectRawExport(userId);
    const sections = this.resolveSections(options.sections);
    const scoped = this.scopeAndSection(raw.tables, sections, options);
    const obfuscated = this.obfuscate(scoped, options.multiplier);
    const withoutCustomCodes = this.pseudonymiseCustomCurrencies(
      obfuscated,
      userId,
    );
    const remapped = this.remapIdentifiers(withoutCustomCodes, userId);

    const payload: Record<string, unknown> = {
      version: raw.version,
      exportedAt: raw.exportedAt,
      supportBackup: true,
      sections,
      ...remapped,
    };
    // The support path holds more copies of the dataset at once than any other
    // export -- the raw tables, the scoped copy, the obfuscated copy, the
    // currency-rewritten copy, the remapped copy, then a JSON string, then a
    // Buffer of it, then the gzip output -- and it had no ceiling at all. It
    // cannot stream, because reconciling scaled balances needs every table
    // together, so the ceiling is the only thing standing between a large
    // dataset and an OOM-killed pod that leaves no artifact and no readable
    // error. The same budget the buffered export uses, since the peak is worse
    // here, not better.
    const json = JSON.stringify(payload);
    const limit = this.backupService.exportBufferLimitBytes;
    const size = Buffer.byteLength(json, "utf-8");
    if (size > limit) {
      throw new PayloadTooLargeException(
        tr(
          "errors.backup.supportExportTooLarge",
          `This support backup would be ${Math.round(size / (1024 * 1024))} MiB of JSON, ` +
            `above the ${Math.round(limit / (1024 * 1024))} MiB limit. Narrow it with an ` +
            `account selection or a date range, or raise BACKUP_EXPORT_BUFFER_LIMIT.`,
          {
            size: Math.round(size / (1024 * 1024)),
            limit: Math.round(limit / (1024 * 1024)),
          },
        ),
      );
    }

    const gzipped = gzipSync(Buffer.from(json, "utf-8"));
    // encryptBackup derives its AES-256-GCM key from the user's password
    // (scrypt), not from ENCRYPTION_KEY, so a support backup encrypts fine
    // regardless of whether that env var is configured.
    return { buffer: await encryptBackup(gzipped, password), encrypted: true };
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
    return this.reconcile(dedupeMaskedText(reconcileSharedSupport(result)));
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
   * Replaces user-created currency codes, names and symbols, and rewrites every
   * reference to them.
   *
   * `currencies.code`, `name` and `symbol` were kept verbatim, on the reasoning
   * that the table holds public reference data. For the canonical rows it does.
   * For a row a user created, all three are free text: the code is any three
   * characters, the name is up to 100, the symbol up to 10. So a currency called
   * `KEN / Kenneth Lasko Family Credits / KL` travelled unchanged inside an
   * artifact documented as de-identified, next to the masked payee and account
   * names it contradicted. Encryption does not help: it protects the file in
   * transit, and the recipient is the person the masking is for.
   *
   * Canonical rows (`created_by_user_id IS NULL`) keep everything -- they are
   * genuinely public, and masking `USD` would make a reproduction harder to read
   * for no gain.
   *
   * The replacement code is random per export rather than derived from the
   * original, so two artifacts from the same user cannot be lined up by it. It
   * stays three characters (the column's width, and what every reference
   * expects), and avoids both the codes already in this payload and the curated
   * catalog, so a pseudonym can never be mistaken for a real currency.
   *
   * `decimal_places` is kept: it is the arithmetic, and changing it would alter
   * every amount's meaning in a file whose whole purpose is reproducing a
   * calculation.
   *
   * References are rewritten through `CURRENCY_REFERENCE_COLUMNS` -- named
   * columns, not a string sweep. A three-character code appears by chance inside
   * masked text often enough that a generic walker would corrupt unrelated
   * values, and the schema-scanning guard in
   * `currencies/currency-references.spec.ts` is what keeps the named list honest.
   *
   * `created_by_user_id` is rewritten to the exporting user's own id, which
   * `remapIdentifiers` then replaces along with everything else. Currencies are
   * shared, and the export deliberately includes every code the user's data
   * references whoever defined it -- so a custom currency another user of the same
   * instance created arrives here carrying *that* user's real UUID. It has no
   * `id` column for the row-id sweep to catch, so the value would survive
   * remapping verbatim and defeat the one thing remapping is for: two support
   * files from two users of one instance could be lined up by the creator id they
   * share. The restore overwrites this column with the restoring user's id in any
   * case, so nothing downstream depends on the original.
   */
  private pseudonymiseCustomCurrencies(
    tables: TableMap,
    userId: string,
  ): TableMap {
    const currencies = tables.currencies;
    if (!currencies?.length) return tables;

    const custom = currencies.filter(
      (row) =>
        row.created_by_user_id !== null && row.created_by_user_id !== undefined,
    );
    if (custom.length === 0) return tables;

    const taken = new Set<string>([
      ...currencies.map((row) => String(row.code)),
      ...Object.keys(CURRENCY_METADATA),
    ]);
    const codeMap = new Map<string, string>();
    for (const row of custom) {
      const original = String(row.code);
      codeMap.set(original, allocatePseudonymCode(taken));
    }

    const result: TableMap = { ...tables };
    result.currencies = currencies.map((row) => {
      const replacement = codeMap.get(String(row.code));
      if (!replacement) return row;
      return {
        ...row,
        code: replacement,
        name: maskText(row.name),
        // A generic currency sign: shape-preserving replacements leak length,
        // and one character is all any renderer needs.
        symbol: GENERIC_CURRENCY_SYMBOL,
        // Another user's real UUID would otherwise survive remapping, since
        // `currencies` has no `id` column for the row-id sweep to collect.
        created_by_user_id: userId,
      };
    });

    for (const [table, columns] of Object.entries(CURRENCY_REFERENCE_COLUMNS)) {
      const rows = result[table];
      if (!rows) continue;
      result[table] = rows.map((row) => {
        let next = row;
        for (const column of columns) {
          const replacement = codeMap.get(String(row[column]));
          if (replacement) next = { ...next, [column]: replacement };
        }
        return next;
      });
    }

    return result;
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
