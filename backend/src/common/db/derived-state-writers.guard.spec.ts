import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

/**
 * Source-scanning guards for the two mistakes the Phase 4 concurrency audit found
 * over and over, in different files, each time looking locally reasonable.
 *
 * A rule in prose gets read, agreed with, and violated anyway -- so these are
 * tests. They scan the source rather than exercising behaviour, because both
 * mistakes are mechanical: not "this calculation is wrong" but "this shape is the
 * wrong shape", and the next instance will be in a file nobody thought to check.
 *
 * Both lists below are allowlists of *reviewed* exceptions. An entry needs a
 * reason, and the list may only shrink.
 */
const SRC = join(__dirname, "..", "..");

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, "/");
}

describe("derived financial state has one set of writers", () => {
  /**
   * `accounts.current_balance` is written by exactly two protocols -- an atomic
   * delta and an absolute recomputation -- and they only compose because every
   * writer takes the account lock before reading the inputs it writes back.
   *
   * A new site that assembles its own `UPDATE accounts SET current_balance`
   * bypasses that agreement, which is how a recomputation silently overwrote a
   * committed delta (audit P4-005). Route it through `AccountsService`.
   */
  it("writes current_balance only from the sanctioned services", () => {
    const ALLOWED = new Set([
      // The two protocols themselves, and the lock that makes them compose.
      "accounts/accounts.service.ts",
      // Post-import recomputation: bulk, and locked through the shared helper.
      "import/import-post-processing.service.ts",
      // Demo-mode seeding writes balances alongside the rows it invents.
      "database/demo-seed.service.ts",
      "database/seed.service.ts",
      // A restore replaces whole rows, balances included, under preserved
      // timestamps -- it is restoring a snapshot, not maintaining a balance.
      "backup/backup.service.ts",
      // The `.mny` importer writes balances inside its one import transaction.
      "import/mny/writers/write-transactions.ts",
      // Undo/redo recomputes the accounts its replay touched, under the shared
      // account lock.
      "action-history/action-history.service.ts",
      // Delete-my-data resets every account to its opening balance; there is no
      // ledger left to recompute from.
      "users/users.service.ts",
      // Demo mode's daily reset owns the whole dataset it invents.
      "database/demo-reset.service.ts",
      // The protocol note itself quotes the statement it is describing.
      "common/db/locks.ts",
    ]);

    const offenders = sourceFiles()
      .filter((file) => /current_balance\s*=/.test(read(file)))
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  /**
   * A balance delta must be derived from the ledger version the write replaces.
   *
   * The shape that breaks it is a read *before* the transaction whose values are
   * then used to adjust a balance *inside* it -- two concurrent requests each
   * held that snapshot and the second reversed an amount the first had already
   * replaced (audit P4-003). The locked readers in `common/db/locks.ts` are how a
   * service reads those values instead.
   */
  it("derives balance deltas from locked reads, not entity snapshots", () => {
    const ALLOWED = new Set([
      // The helper that performs the locked read.
      "common/db/locks.ts",
    ]);

    const offenders = sourceFiles()
      .filter((file) => {
        const source = read(file);
        // A service that adjusts balances at all must have a locked reader, or a
        // documented reason not to.
        const adjustsBalances = /accountsService\.updateBalance\(/.test(source);
        if (!adjustsBalances) return false;
        return !/lockTransactionRow|lockTransactionRows|lockAccountsForBalanceWrite/.test(
          source,
        );
      })
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    // Every remaining balance-adjusting service reads its old values under a
    // lock. A new one that does not is the P4-003 shape again.
    expect(offenders).toEqual([]);
  });

  /**
   * A balance reversal must be gated on the row this call actually removed.
   *
   * `manager.remove(entity)` deletes by primary key and reports nothing, so two
   * concurrent removals each reversed the same amount while one row went away --
   * and it reversed whatever the *snapshot* held, and reversed it even for a VOID
   * row that had contributed nothing. That is four separate mistakes in one
   * four-line shape, which is why it survived three fixes and reappeared a fourth
   * time in split removal (audit FV4-002).
   *
   * `removeLockedTransactionLeg` is the whole sequence in one place. This scan
   * fails on any *new* file that reverses a balance with a bare `remove()` beside
   * it -- the mistake is mechanical, so the guard is a scan and not a review note.
   */
  it("removes a ledger row conditionally wherever it reverses a balance", () => {
    const ALLOWED = new Map([
      [
        "securities/investment-transactions.service.ts",
        "reverseTransactionEffectsInTransaction reverses HOLDINGS under the " +
          "holdings advisory lock, not accounts.current_balance from a ledger " +
          "snapshot; its cash-leg deletions already read affectedRowCount",
      ],
      [
        "import/import-post-processing.service.ts",
        "recomputes balances absolutely under the shared account lock after an " +
          "import; there is no per-row delta to gate",
      ],
    ]);

    const offenders = sourceFiles()
      .filter((file) => {
        const source = read(file);
        // A file that reverses a ledger row's contribution to a balance.
        if (!/accountsService\.updateBalance\(/.test(source)) return false;
        // ...and still deletes a transaction-shaped row by entity identity.
        return /\b(?:m|manager|txRepo|repo)\s*\.\s*remove\s*\(\s*(?!allSplits|splits\b)\w*(?:[Tt]ransaction|[Ll]eg|[Tt]x)\w*\s*[,)]/.test(
          source,
        );
      })
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  /**
   * Every backend replica fires every cron (`docs/cron-jobs.md`), so a guard held
   * in process memory is not a guard: each replica has its own.
   *
   * A `Set` or `Map` of user ids beside an `@Cron` handler is the shape that
   * produced duplicate AI provider calls and duplicate emails (P4-013, P4-018).
   * Use `JobClaimService`.
   */
  it("does not guard cron work with process-local state", () => {
    const ALLOWED = new Map([
      [
        "ai/insights/ai-insights.service.ts",
        "generatingUsers is a cheap local short-circuit ONLY; the exclusion is a durable lease",
      ],
      [
        "net-worth/net-worth.service.ts",
        "recalcTimers is a debounce registry, not a guard: it coordinates nothing " +
          "and duplicate work is harmless (the recalc is an absolute recomputation " +
          "under the account lock). Losing a timer is made recoverable by " +
          "sweepStaleSnapshots, which derives the staleness from accounts.updated_at " +
          "rather than from anything held in memory",
      ],
    ]);

    const offenders = sourceFiles()
      .filter((file) => {
        const source = read(file);
        if (!/@Cron\(/.test(source)) return false;
        // A field holding a Set/Map of ids at class scope, beside a cron.
        return /^\s*private\s+(?:readonly\s+)?\w+\s*[:=]\s*(?:new\s+)?(?:Set|Map)\b/m.test(
          source,
        );
      })
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  /**
   * TypeORM returns `[rows, rowCount]` for `UPDATE` and `DELETE` -- with or
   * without a `RETURNING` clause -- and bare rows for everything else. So a
   * `length` check on an `UPDATE ... RETURNING` result is not merely fragile: it
   * is testing 2 against 0 and can only ever take one branch.
   *
   * That is not a hypothetical. `TourService.saveProgress` had a
   * `updated.length === 0` guard whose whole job was to materialize a missing
   * preferences row, and it could not fire; the row stayed missing and the tour
   * progress went nowhere while the endpoint answered `{ saved: true }`. Nothing
   * about the call site shows the shape, so this is a scan, not a review note.
   */
  it("never reads an UPDATE/DELETE result with an open-coded length check", () => {
    /**
     * `.query(...)` calls whose result is bound to a name, paren-matched so a
     * multi-line SQL template is captured whole.
     */
    function boundQueryCalls(
      source: string,
    ): Array<{ line: number; sql: string; variable: string }> {
      const calls: Array<{ line: number; sql: string; variable: string }> = [];
      for (const match of source.matchAll(
        /(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?=\s*(?:await\s+)?[\w.]*\.query\s*\(/g,
      )) {
        let depth = 0;
        let i = match.index! + match[0].length - 1;
        const start = i;
        while (i < source.length) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")" && --depth === 0) break;
          i++;
        }
        calls.push({
          line: source.slice(0, match.index!).split("\n").length,
          sql: source.slice(start, i),
          variable: match[1],
        });
      }
      return calls;
    }

    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      const lines = source.split("\n");
      for (const { line, sql, variable } of boundQueryCalls(source)) {
        // The statement's first word, read from the literal the call passes. A
        // call that passes a variable (`query(sql, params)`) shows nothing here
        // and is skipped -- a scan can only see what is written inline.
        const firstWord = sql.match(/[`"']\s*(\w+)/)?.[1] ?? "";
        // Only the tuple-shaped commands can mislead a length check.
        if (!/^(UPDATE|DELETE)$/i.test(firstWord)) continue;

        // How that specific binding is consumed, a little way past the call.
        const after = lines.slice(line - 1, line + 20).join("\n");
        const lengthCheck = new RegExp(
          `\\b${variable}\\s*\\.length\\s*(?:===|!==|==|>|<|>=|<=)`,
        );
        if (lengthCheck.test(after)) {
          offenders.push(`${relative(file)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * `ActionHistoryService.record` swallows its own failures on purpose: recording
   * an undo entry must never fail the operation the user actually asked for. That
   * is only safe *outside* a transaction. Called inside one, a failed insert has
   * already aborted the caller's transaction, and swallowing the error hides it
   * until the next statement dies with `25P02 in_failed_sql_transaction` -- so
   * the user's write fails, with a message about the audit trail.
   *
   * Nothing about the call site says which side of the boundary it is on, which is
   * exactly the kind of mistake prose does not prevent. Currently zero call sites
   * are inside a transaction; this keeps it that way.
   */
  it("records action history outside the caller's transaction, never inside it", () => {
    /** The body of each `withScopedDb(...)` call in a file, by paren matching. */
    function scopedDbCallbacks(source: string): string[] {
      const bodies: string[] = [];
      for (const match of source.matchAll(/withScopedDb\s*\(/g)) {
        let depth = 0;
        let i = match.index! + match[0].length - 1;
        const start = i;
        while (i < source.length) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")" && --depth === 0) break;
          i++;
        }
        bodies.push(source.slice(start, i));
      }
      return bodies;
    }

    const offenders = sourceFiles()
      .filter((file) =>
        scopedDbCallbacks(read(file)).some((body) =>
          /\bactionHistory\w*\s*\.\s*record\s*\(/.test(body),
        ),
      )
      .map(relative);

    expect(offenders).toEqual([]);
  });
});
