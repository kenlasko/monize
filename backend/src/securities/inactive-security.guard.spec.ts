import { readFileSync } from "fs";
import { join } from "path";

const ROOT = __dirname;

/**
 * Every write path that adds, changes, removes or voids an investment
 * transaction, and the function inside each that must refuse a deactivated
 * security (issue #2323).
 *
 * Deactivation requires a zero position; the security deactivated, a deleted
 * row put shares back and the security could no longer be activated from the
 * list. The refusal is only as good as its least-guarded entry point, so the
 * rule is a scan: a new write path that does not ask fails here.
 *
 * `beforeWrite` marks a site that receives an ambient `EntityManager` rather
 * than opening its own `withScopedDb`; its assertion must precede the named
 * first write. A site without it opens its own `withScopedDb` and the
 * assertion must sit inside it.
 *
 * The list may grow. Removing an entry means the path no longer writes an
 * investment row, which is a change worth arguing for in the diff. The backup
 * restore, the MNY/KMY import (a wipe into fresh securities), `removeAll` and
 * the account and user deletes are deliberately absent: they replace or erase
 * the whole ledger rather than change a security's rows.
 */
const ENFORCEMENT_SITES: {
  file: string;
  fn: string;
  why: string;
  beforeWrite?: string;
}[] = [
  {
    file: "investment-transactions.service.ts",
    fn: "  async create(",
    why: "POST /investment-transactions, the AI and MCP creates, scheduled postings and trade emails",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async transferSecurity(",
    why: "POST /investment-transactions/transfer-security",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async update(",
    why: "PATCH /investment-transactions/:id and the AI and MCP edits",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  private async updateLinkedTransfer(",
    why: "the edit of a linked transfer leg, which rewrites both legs",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async updateStatus(",
    why: "PATCH /investment-transactions/:id/status across the VOID boundary",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async remove(",
    why: "DELETE /investment-transactions/:id and the AI and MCP deletes",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async createEmbeddedForSplit(",
    why: "an investment line of a split cash transaction, created or rebuilt",
    beforeWrite: "manager.save(",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async reverseAndRemoveEmbedded(",
    why: "an investment line removed from a split, or the split parent deleted",
    beforeWrite: "manager.remove(",
  },
  {
    file: "investment-transactions.service.ts",
    fn: "  async applyParentStatusToEmbeddedRows(",
    why: "the split parent voided or restored, which moves its embedded rows' shares",
    beforeWrite: "manager.update(InvestmentTransaction",
  },
  {
    file: "../action-history/action-history.service.ts",
    fn: "  private async undoInvestmentUpdate(",
    why: "undo/redo of a transfer edit restores both legs",
    beforeWrite: "manager.update(",
  },
  {
    file: "../action-history/action-history.service.ts",
    fn: "  private async undoInvestmentCreate(",
    why: "undo of a create deletes the rows",
    beforeWrite: "manager.remove(",
  },
  {
    file: "../action-history/action-history.service.ts",
    fn: "  private async undoInvestmentDelete(",
    why: "undo of a delete reinserts the rows",
    beforeWrite: "INSERT INTO transactions",
  },
  {
    file: "../import/import-investment-processor.service.ts",
    fn: "  async processTransaction(",
    why: "a QIF, OFX or CSV row mapped onto an existing security",
    beforeWrite: "ctx.manager.save(investmentTx",
  },
];

const ASSERTION = /assertSecuritiesActiveIn\s*\(/;

/**
 * The text of `fn` in `source`, from its signature to the start of the next
 * class member: class members are the only things in these files indented by
 * exactly two spaces (the same reading as `reconciled-lock.guard.spec.ts`).
 */
const NEXT_MEMBER =
  /\n {2}(?:\/\*\*|(?:private |protected |public )?(?:readonly |static )?(?:async )?[A-Za-z_$][\w$]*\s*[(<])/;

function methodBody(source: string, signature: string): string | null {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const rest = source.slice(start + signature.length);
  const next = rest.search(NEXT_MEMBER);
  return next === -1 ? source.slice(start) : rest.slice(0, next);
}

describe("a deactivated security's investment rows are refused on every write path (#2323)", () => {
  const sources = new Map<string, string>();
  for (const { file } of ENFORCEMENT_SITES) {
    if (!sources.has(file)) {
      sources.set(file, readFileSync(join(ROOT, file), "utf8"));
    }
  }

  it.each(ENFORCEMENT_SITES)("$file $fn ($why)", ({ file, fn }) => {
    const body = methodBody(sources.get(file)!, fn);
    // A null body means the signature moved: update ENFORCEMENT_SITES rather
    // than deleting the entry, or the path silently stops being scanned.
    expect(body).toBeTruthy();
    expect(ASSERTION.test(body!)).toBe(true);
  });

  it("still recognises the assertion, so the rule cannot pass by accident", () => {
    const util = readFileSync(join(ROOT, "inactive-security.util.ts"), "utf8");
    expect(util).toContain("export async function assertSecuritiesActiveIn(");
  });

  it("refuses before the write, not after it", () => {
    const outside = ENFORCEMENT_SITES.filter(({ file, fn, beforeWrite }) => {
      const body = methodBody(sources.get(file)!, fn)!;
      const assertion = body.search(ASSERTION);
      if (beforeWrite) {
        const write = body.indexOf(beforeWrite);
        return write === -1 || assertion === -1 || assertion > write;
      }
      const scoped = body.indexOf("withScopedDb");
      return scoped === -1 || assertion < scoped;
    }).map(({ file, fn }) => `${file} ${fn.trim()}`);
    expect(outside).toEqual([]);
  });
});
