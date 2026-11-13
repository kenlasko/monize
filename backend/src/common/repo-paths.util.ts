import { basename } from "path";

import { escapeRegExp } from "./escape-regexp.util";
import { LEGACY_PREFIX_WIDTH } from "./db/migration-filename";

/**
 * The grammar and inventory that decide whether a written reference to a file --
 * in a doc, a source comment, or a migration comment -- is a claim about this
 * tree, and whether that claim resolves.
 *
 * Extracted from `doc-paths.spec.ts` so a second guard (`source-comment-paths`)
 * can reuse it rather than copy it: a `.spec.ts` cannot be imported without
 * re-registering its `describe` blocks, and a path grammar spelled out twice is
 * exactly the drift these guards exist to catch.
 *
 * Three strengths of claim, matched to what each kind of reference can promise:
 *
 *  - A **rooted** path (`backend/src/...`, `database/...`) is an exact claim and
 *    must resolve exactly.
 *  - A **relative** path (`map/map-loans.ts`) or a **bare filename**
 *    (`schema.sql`) is a readable shorthand, so it only has to match some file's
 *    path suffix somewhere in the tree. Bare names count: a migration filename
 *    such as 133_currency_global_liveness.sql once sat in a contract describing
 *    a migration that was never in the tree (named in prose here, not a span,
 *    because it is absent), and a slash-only grammar let it.
 *  - In `docs/future-plans/` a path may name a file that does not exist yet, so
 *    non-existence alone proves nothing there. What a plan must not do is name a
 *    file that exists *somewhere else*: an unresolved path whose basename lives
 *    at another location is a stale reference to a moved or renamed file, not a
 *    planned one.
 *
 * Cross-tree references are not claims about this tree and are exempt by grammar:
 * `branch:path/to/file.md`, image tags (`ghcr.io/...:latest`), and URLs. A
 * `path:42` / `path:95-97` line reference, by contrast, IS a claim about `path`
 * and is checked with the lines stripped.
 */

const EXTENSIONS = "ts|tsx|sql|mjs|cjs|js|json|sh|ya?ml|md";

/** Extensions longest-first, for scanning a path token out of running prose. */
const EXTENSIONS_LONGEST_FIRST = "tsx|ts|sql|mjs|cjs|json|js|sh|yaml|yml|md";

/** Prefixes that make a path a claim about an exact location. */
export const ROOTED = [
  "backend/",
  "frontend/",
  "database/",
  "docs/",
  "helm/",
  "scripts/",
  "e2e/",
  "desktop/",
  "mobile/",
  ".github/",
  ".claude/",
];

/**
 * Spans that are deliberately not files in this tree. Each needs a reason, not
 * just an entry.
 */
const NOT_REPO_PATHS: RegExp[] = [
  /^https?:/, // URLs
  /^\/(?:data|app|tmp|etc|root)\//, // container and host paths
  /\.{3}/, // `.../interceptors/foo.ts` ellipsis shorthand
  /(?:^|\/)\d*N{2,}_/, // `NNN_description.sql`, `0NN_rls_...` numbering placeholders
  /(?:^|\/)YYYYMMDDHHMMSS_/, // `YYYYMMDDHHMMSS_description.sql`, the timestamp placeholder
];

export type PathClaim = { kind: "rooted" | "relative" | "bare"; path: string };
export type Claim = PathClaim | { kind: "cross-tree" | "not-path" };

export const isPathClaim = (claim: Claim): claim is PathClaim =>
  claim.kind === "rooted" || claim.kind === "relative" || claim.kind === "bare";

/**
 * Decide what, if anything, a span claims about this tree. Pure, so the grammar
 * itself is unit-tested.
 */
export function classifySpan(span: string): Claim {
  if (NOT_REPO_PATHS.some((p) => p.test(span))) return { kind: "not-path" };

  // `path:42` / `path:95-97` is a line reference: a claim about the path part.
  // Any other colon-qualified span (`branch:path`, `image:tag`) references a
  // tree that is not this one, and is exempt -- explicitly, not by a character
  // class accident.
  const lineRef = /^([A-Za-z0-9_.@/-]+):\d+(?:-\d+)?$/.exec(span);
  const path = lineRef ? lineRef[1] : span;
  if (!lineRef && span.includes(":")) {
    return /^[A-Za-z0-9_.@/-]+:[A-Za-z0-9_.@:/-]+$/.test(span)
      ? { kind: "cross-tree" }
      : { kind: "not-path" };
  }

  // A path claim is path characters ending in a known extension. Globs (`*`)
  // and templates (`{locale}`) fail this grammar outright.
  if (!new RegExp(`^[A-Za-z0-9_.@/-]+\\.(?:${EXTENSIONS})$`).test(path)) {
    return { kind: "not-path" };
  }

  if (ROOTED.some((prefix) => path.startsWith(prefix))) {
    return { kind: "rooted", path };
  }
  if (path.includes("/")) return { kind: "relative", path };
  // A leading dot is an extension being named (`.controller.spec.ts`), not a
  // file.
  if (!/^[A-Za-z0-9]/.test(path)) return { kind: "not-path" };
  return { kind: "bare", path };
}

export interface FileIndex {
  /** Exact repo-relative paths. */
  set: Set<string>;
  list: string[];
  /** basename -> every repo-relative path carrying it. */
  byBasename: Map<string, string[]>;
}

export function buildIndex(paths: string[]): FileIndex {
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const name = basename(p);
    byBasename.set(name, [...(byBasename.get(name) ?? []), p]);
  }
  return { set: new Set(paths), list: paths, byBasename };
}

const pathPresent = (
  path: string,
  kind: PathClaim["kind"],
  index: FileIndex,
): boolean =>
  kind === "rooted"
    ? index.set.has(path)
    : // relative and bare: some file's path suffix.
      index.set.has(path) || index.list.some((f) => f.endsWith(`/${path}`));

const resolves = (
  claim: PathClaim,
  index: FileIndex,
  compiledJs: boolean,
): boolean => {
  if (pathPresent(claim.path, claim.kind, index)) return true;
  // A `.js` reference is satisfied by its TypeScript source: source comments
  // name the compiled runtime the deployment actually executes
  // (`node dist/db-migrate.js`, then `main.js`), whose source in this tree is
  // `.ts`. This is scoped to the comment scan (`compiledJs`) and off for docs,
  // whose exact-path rule must not be loosened -- every `.js` a doc names is a
  // real `.js` file (`next.config.js`), so docs never need it. It never masks a
  // real gap either: a `.js` with no `.ts` sibling still fails.
  if (compiledJs && /\.js$/.test(claim.path)) {
    return [".ts", ".tsx"].some((ext) =>
      pathPresent(claim.path.replace(/\.js$/, ext), claim.kind, index),
    );
  }
  return false;
};

/**
 * The strict check, for binding contracts: every claim must resolve. Returns a
 * problem description, or null. Docs call it plain; the source-comment scan
 * passes `{ compiledJs: true }` so a comment may name the compiled `.js`
 * runtime of a `.ts` source.
 */
export function strictProblem(
  span: string,
  index: FileIndex,
  opts: { compiledJs?: boolean } = {},
): string | null {
  const claim = classifySpan(span);
  if (!isPathClaim(claim)) return null;
  if (resolves(claim, index, opts.compiledJs ?? false)) return null;
  const elsewhere = index.byBasename.get(basename(claim.path));
  return elsewhere
    ? `${span} does not resolve (a file with that name lives at ${elsewhere.join(", ")})`
    : `${span} does not resolve`;
}

/**
 * The plan check, for `docs/future-plans/`: a claim may name an unbuilt file,
 * but an unresolved claim whose basename exists elsewhere in the tree is a
 * stale reference to a moved or renamed file, not a plan.
 */
export function planProblem(span: string, index: FileIndex): string | null {
  const claim = classifySpan(span);
  if (!isPathClaim(claim)) return null;
  if (resolves(claim, index, false)) return null;
  const elsewhere = index.byBasename.get(basename(claim.path));
  if (!elsewhere) return null; // exists nowhere: a planned file
  return `${span} names a moved or renamed file (it lives at ${elsewhere.join(", ")})`;
}

/** Inline backticked spans of a doc, with fenced code blocks stripped first. */
export function docSpans(text: string): string[] {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Comment extraction -- string- and template-aware, so a path or a `--` inside
// a string literal is never read as a claim (issue #1093, criterion 2).
// ---------------------------------------------------------------------------

/**
 * A `/` may begin a regex literal, or divide. It divides after an operand; it
 * begins a regex after an operator or one of these keywords. Getting this wrong
 * only matters where a regex body carries `//` or `/*` -- rare, but a regex read
 * as code would surface its `//` as a phantom line comment, so the scanner
 * consumes regex literals rather than risk that false positive.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
  "throw",
]);

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

/** From an opening quote, return the index just past the closing quote. */
function skipQuoted(src: string, i: number, quote: string): number {
  i++;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote || c === "\n") return i + 1;
    i++;
  }
  return i;
}

/**
 * From an opening backtick, scan a template literal, collecting comments from
 * its `${...}` interpolations, and return the index just past the closing
 * backtick. Template text between the interpolations is not code, so a path in
 * it is never a claim -- but an interpolation body *is* code (a block comment
 * can sit inside a `${ }`), so it is scanned rather than skipped (issue #1093
 * review).
 */
function scanTemplate(src: string, i: number, comments: string[]): number {
  i++;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      i = scanCode(src, i + 2, comments, true);
      continue;
    }
    i++;
  }
  return n;
}

/**
 * Scan `src` from `i` as code, pushing every `//` and block comment body onto
 * `comments`, with string and template literals and regexes skipped. When
 * `interp` is set the scan is inside a `${...}`: it tracks brace depth and
 * returns the index just past the `}` that closes the interpolation, so a nested
 * object literal does not end it early. Mutually recursive with `scanTemplate`.
 */
function scanCode(
  src: string,
  i: number,
  comments: string[],
  interp: boolean,
): number {
  const n = src.length;
  let prevSignificant = "";
  let word = "";
  let lastWord = "";
  let depth = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (interp && ch === "}" && depth === 0) return i + 1;
    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      comments.push(src.slice(i + 2, j));
      i = j;
      prevSignificant = "";
      word = "";
      lastWord = "";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      comments.push(src.slice(i + 2, end < 0 ? n : end));
      i = end < 0 ? n : end + 2;
      prevSignificant = "/";
      word = "";
      continue;
    }
    if (ch === "/") {
      const precedingWord = word || lastWord;
      const dividing =
        /[\w)\]}"'`]/.test(prevSignificant) &&
        !REGEX_PRECEDING_KEYWORDS.has(precedingWord);
      i = dividing ? i + 1 : skipRegex(src, i);
      prevSignificant = "/";
      word = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i, ch);
      prevSignificant = ch;
      word = "";
      continue;
    }
    if (ch === "`") {
      i = scanTemplate(src, i, comments);
      prevSignificant = "`";
      word = "";
      continue;
    }
    if (ch === "{") {
      depth++;
      prevSignificant = ch;
      word = "";
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      prevSignificant = ch;
      word = "";
      i++;
      continue;
    }
    if (isIdentChar(ch)) {
      word += ch;
      prevSignificant = ch;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    if (word) lastWord = word;
    word = "";
    i++;
  }
  return i;
}

/** From a `/` that begins a regex literal, return the index past its flags. */
function skipRegex(src: string, i: number): number {
  const n = src.length;
  i++;
  let inClass = false;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i; // unterminated -- bail without consuming the line
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      break;
    }
    i++;
  }
  while (i < n && /[a-z]/.test(src[i])) i++; // flags
  return i;
}

/**
 * Every `//` and block comment body in a TypeScript/JavaScript source --
 * including comments inside `${...}` template interpolations -- with string and
 * template literals and regexes skipped. Pure, unit-tested.
 */
export function extractTsComments(src: string): string[] {
  const comments: string[] = [];
  scanCode(src, 0, comments, false);
  return comments;
}

/** From an opening `$tag$` or `$$`, the matching closing marker, or null. */
function dollarQuoteMarker(src: string, i: number): string | null {
  const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(src.slice(i));
  return m ? m[0] : null;
}

/**
 * Every `--` and block comment body in a SQL source, with single-quoted strings
 * (`''` escapes) and dollar-quoted strings skipped. The `-- enforced by ...`
 * that lives *inside* a `COMMENT ON FUNCTION ... IS '...'` literal is a string,
 * not a comment, and must not be read as one (issue #1093, criterion 2).
 */
export function extractSqlComments(sql: string): string[] {
  const comments: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      // An `E'...'` escape string processes backslash escapes, so `\'` is a
      // quote, not the string's end. A standard string does not: there `\` is a
      // literal and only `''` escapes a quote. Both allow `''`. Reading `\'` as
      // an ending in an E-string would leak the rest as code and misread a `--`
      // after it as a comment (issue #1093 review).
      const prev = sql[i - 1];
      const prev2 = sql[i - 2] ?? "";
      const eString =
        (prev === "E" || prev === "e") && !/[A-Za-z0-9_]/.test(prev2);
      i++;
      while (i < n) {
        if (eString && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$") {
      const marker = dollarQuoteMarker(sql, i);
      if (marker) {
        const end = sql.indexOf(marker, i + marker.length);
        i = end < 0 ? n : end + marker.length;
        continue;
      }
    }
    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      comments.push(sql.slice(i + 2, j));
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
          continue;
        }
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      comments.push(sql.slice(start, depth === 0 ? j - 2 : j));
      i = j;
      continue;
    }
    i++;
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Claims inside a comment.
// ---------------------------------------------------------------------------

/**
 * The pattern that finds a rooted path in running prose, built from a list of
 * prefixes. Exported (rather than inlined over `ROOTED`) so the escaping can be
 * tested against a prefix carrying a metacharacter: every entry in `ROOTED`
 * today contains at most a dot, which is exactly why an escape that handled
 * only dots read as complete.
 */
export function buildPlainRootedPathPattern(prefixes: string[]): RegExp {
  const alternatives = prefixes
    .map((prefix) => escapeRegExp(prefix.replace(/\/$/, "")))
    .join("|");
  return new RegExp(
    `(?<![\\w./@-])(?:${alternatives})/[\\w./@-]*?\\.(?:${EXTENSIONS_LONGEST_FIRST})(?![\\w])`,
    "g",
  );
}

const PLAIN_ROOTED_PATH = buildPlainRootedPathPattern(ROOTED);

/**
 * The path claims a single comment makes. Backticked spans are the strong idiom
 * and are read at every strength (rooted, relative, bare) -- that is how a spec
 * renamed out from under a comment (currency-reference-columns.spec.ts, now
 * `currency-references.spec.ts`) is caught. Plain
 * running prose only makes a checkable claim when it names a fully **rooted**
 * path: a bare word or a `foo/bar` fragment in a sentence is too ambiguous to
 * demand resolution, but `backend/src/db-init.ts` is unmistakable.
 */
export function commentPathSpans(comment: string): string[] {
  const backticked = [...comment.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const plainRooted = comment.match(PLAIN_ROOTED_PATH) ?? [];
  return [...new Set([...backticked, ...plainRooted])];
}

// ---------------------------------------------------------------------------
// Migration-number references (issue #1093): "migration 136", "migrations 133
// and 134", "sibling in 136", and the same forms with a fourteen-digit
// timestamp. Resolved by filename, not path logic -- a migration is named
// `NNN_description.sql` (historical) or `YYYYMMDDHHMMSS_description.sql`, so
// the number is the identity.
// ---------------------------------------------------------------------------

/**
 * A migration number as it appears in prose: the historical two-to-four digit
 * form, or the fourteen-digit timestamp. The timestamp alternative is tried
 * first and both end on a word boundary, so a timestamp is never read as its
 * first four digits (which would name a migration that does not exist).
 */
const MIGRATION_NUMBER = String.raw`(?:\d{14}|\d{2,4})\b`;

/**
 * The migration numbers referenced by a comment. Two anchors, each a form that
 * actually occurs in this tree, and no more -- a bare number with no migration
 * cue ("as 100", "in 349", "AES-256") is never read as a reference, because
 * that is the false positive criterion 2 forbids:
 *
 *  - `migration(s) N [and/, M ...]` -- the canonical form, dozens of uses.
 *  - `sibling in N` -- the one cross-reference in the tree that names a
 *    migration by bare number without the word "migration".
 */
export function migrationRefs(comment: string): number[] {
  const numbers: number[] = [];
  for (const m of comment.matchAll(
    new RegExp(
      String.raw`\bmigrations?\s+(${MIGRATION_NUMBER}(?:\s*(?:,|and|&)\s*${MIGRATION_NUMBER})*)`,
      "gi",
    ),
  )) {
    for (const n of m[1].match(new RegExp(MIGRATION_NUMBER, "g")) ?? []) {
      numbers.push(parseInt(n, 10));
    }
  }
  for (const m of comment.matchAll(
    new RegExp(String.raw`\bsibling in\s+(${MIGRATION_NUMBER})`, "gi"),
  )) {
    numbers.push(parseInt(m[1], 10));
  }
  return numbers;
}

/**
 * The set of migration numbers present in `database/migrations`, historical and
 * timestamp forms alike -- both are the numeric value of the prefix, which is
 * how `migrationRefs` reads them out of prose.
 */
export function buildMigrationIndex(migrationFiles: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const f of migrationFiles) {
    const m = /(?:^|\/)(\d+)_/.exec(f);
    if (m) numbers.add(parseInt(m[1], 10));
  }
  return numbers;
}

/** A referenced migration number that names no migration file is a problem. */
export function migrationProblem(
  ref: number,
  migrations: Set<number>,
): string | null {
  return migrations.has(ref)
    ? null
    : `migration ${ref} does not exist (no database/migrations/${String(ref).padStart(LEGACY_PREFIX_WIDTH, "0")}_*.sql)`;
}
