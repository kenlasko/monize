#!/usr/bin/env node
// Verify the setup and deployment documentation describes files that exist and
// defaults that match the manifests.
//
// The root README told readers to run `docker-compose up -d` against a
// `docker-compose.yml` this repository has never contained, and `helm/README.md`
// installed `./helm/monize` when the chart root is `helm/` -- so the documented
// happy path failed before the application started, in both cases. The Helm
// default-value tables had drifted too: registry, repository, pull policy and
// the backend memory limit all disagreed with `helm/values.yaml`, while the
// templates render the real values.
//
// Prose cannot be type-checked, so this is the check. Six rules:
//
//   1. every repository path a documented command names must exist;
//   2. no documented `docker compose` command may omit `-f`, because there is no
//      default Compose file to fall back on;
//   3. every Helm parameter documented with a default must have that default in
//      helm/values.yaml;
//   4. every Compose stack on disk appears in the README's tree;
//   5. every `npm run <script>` a document offers exists in a package.json;
//   6. every Markdown table row actually renders inside a table.
//
// Exits non-zero with the offending lines. Requires nothing but Node.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.pathname` on a file:// URL is percent-encoded (a space becomes `%20`) and
// `fs` wants a real OS path, not a URL component -- `fileURLToPath` decodes
// it. A repo checked out under a path with a space (not exotic: "My Drive")
// reads that literal `%20` as a directory name and fails on the first read.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Documents whose commands and tables are treated as canonical instructions. */
const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  'e2e/CLAUDE.md',
  'backend/src/mcp/CLAUDE.md',
  'docs/guard-tests.md',
  'docs/agent-instructions.md',
  'docs/backend/mcp.md',
  'helm/README.md',
  'database/CLAUDE.md',
  'backend/CLAUDE.md',
  'frontend/CLAUDE.md',
  'CONTAINER_BUILD.md',
  // Each layer's rules, moved out of its CLAUDE.md so that file could stay an
  // index; they carry the same commands and tables it used to.
  'docs/backend/README.md',
  'docs/backend/testing.md',
  'docs/backend/modules-and-runtime.md',
  'docs/backend/entities-and-dtos.md',
  'docs/backend/database-access-and-tenancy.md',
  'docs/backend/transactions-and-money.md',
  'docs/backend/securities-and-providers.md',
  'docs/backend/ai-and-payees.md',
  'docs/backend/notifications-and-push.md',
  'docs/backend/backup.md',
  'docs/backend/cron-and-background-work.md',
  'docs/frontend/README.md',
  'docs/frontend/api-and-cache.md',
  'docs/frontend/ui-conventions.md',
  'docs/frontend/forms-and-formatting.md',
  'docs/frontend/tables-and-registers.md',
  'docs/frontend/financial-figures.md',
  'docs/frontend/pwa-push-share.md',
  'docs/frontend/testing.md',
  'docs/frontend/theming.md',
  'docs/frontend/screens-and-dialogs.md',
];

/**
 * Every markdown file under docs/, for the npm-script rule only. Rule 5's
 * failure was in `docs/future-plans/`, which none of the canonical instruction
 * files above cover -- limiting the sweep to DOCS would have made the check pass
 * over the defect that motivated it.
 */
function allDocsMarkdown(dir = join(REPO_ROOT, 'docs')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return allDocsMarkdown(full);
    return name.endsWith('.md') ? [full.slice(REPO_ROOT.length)] : [];
  });
}

const failures = [];

function fail(file, line, message) {
  failures.push(`${file}${line ? `:${line}` : ''}  ${message}`);
}

function readDoc(relative) {
  const full = join(REPO_ROOT, relative);
  return existsSync(full) ? readFileSync(full, 'utf8').split('\n') : null;
}

// ---------------------------------------------------------------------------
// Rule 1 + 2: paths and Compose invocations in documented commands
// ---------------------------------------------------------------------------

// A `-f <file>` on a docker compose command.
const COMPOSE_WITH_FILE = /docker[- ]compose\s+(?:[^\n]*?\s)?-f\s+([\w./-]+)/g;
// A docker compose command with no -f anywhere before the subcommand.
const COMPOSE_WITHOUT_FILE = /docker[- ]compose\s+(?!.*-f\s)(up|down|build|exec|run|logs|ps|config)\b/;
// A compose filename mentioned anywhere, including inside a directory tree.
const COMPOSE_FILENAME = /\bdocker-compose[\w.-]*\.ya?ml\b/g;
// `helm <verb> ... ./path` -- the chart directory.
const HELM_CHART = /helm\s+(?:install|upgrade|template|lint)\s+[^\n]*?(\.\/[\w./-]+)/g;

function checkCommands(relative, lines) {
  lines.forEach((text, index) => {
    const lineNumber = index + 1;

    for (const [, file] of text.matchAll(COMPOSE_WITH_FILE)) {
      if (!existsSync(join(REPO_ROOT, file))) {
        fail(relative, lineNumber, `compose file does not exist: ${file}`);
      }
    }

    if (COMPOSE_WITHOUT_FILE.test(text)) {
      fail(
        relative,
        lineNumber,
        'docker compose without -f: this repository has no default docker-compose.yml',
      );
    }

    for (const [name] of text.matchAll(COMPOSE_FILENAME)) {
      if (!existsSync(join(REPO_ROOT, name))) {
        fail(relative, lineNumber, `compose file does not exist: ${name}`);
      }
    }

    for (const [, chart] of text.matchAll(HELM_CHART)) {
      const path = join(REPO_ROOT, chart);
      if (!existsSync(join(path, 'Chart.yaml'))) {
        fail(
          relative,
          lineNumber,
          `not a Helm chart root (no Chart.yaml): ${chart}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 3: documented Helm defaults against helm/values.yaml
// ---------------------------------------------------------------------------

/**
 * Minimal reader for the subset of YAML `helm/values.yaml` uses: nested plain
 * mappings, scalar values, `{}`, and comments. Deliberately not a YAML parser --
 * pulling one in would mean a dependency for a check that must run anywhere, and
 * the file is committed in this shape. Returns a flat map of dotted path to raw
 * scalar text; a key whose value is a nested mapping, a list or `{}` is absent,
 * so a documented row pointing at one is skipped rather than misjudged.
 */
function flattenValues(source) {
  const flat = new Map();
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = [];

  for (const raw of source.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.trim().startsWith('- ')) continue; // list item: not addressable here

    const match = /^(\s*)([\w.-]+):\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (!match) continue;

    const [, indentText, key, value] = match;
    const indent = indentText.length;

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });

    if (value !== '' && value !== '{}' && value !== '[]' && value !== '|') {
      flat.set(
        stack.map((entry) => entry.key).join('.'),
        value.replace(/^["']|["']$/g, ''),
      );
    }
  }

  return flat;
}

// `| `backend.image.tag` | Image tag | `latest` |`
const DEFAULTS_ROW = /^\|\s*`([\w.*-]+)`\s*\|[^|]*\|\s*`([^`|]+)`\s*\|/;

function checkHelmDefaults(relative, lines, values) {
  lines.forEach((text, index) => {
    const match = DEFAULTS_ROW.exec(text);
    if (!match) return;

    const [, path, documented] = match;
    // Rows documenting a whole subtree ("See values.yaml") or a wildcard
    // (`backend.env.*`) address no single scalar.
    if (path.includes('*')) return;
    if (!values.has(path)) return;

    const actual = values.get(path);
    // An empty value in values.yaml means the effective default is derived in a
    // template (`global.hostname: ""` becomes `monize.<domain>`), and the table
    // documents that derivation rather than the literal. Comparing them would
    // fail on correct documentation.
    if (actual === '') return;
    if (actual !== documented) {
      fail(
        relative,
        index + 1,
        `${path} documented as \`${documented}\` but helm/values.yaml has \`${actual}\``,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 4: every Compose stack in the tree is listed in the README's tree
// ---------------------------------------------------------------------------

function checkComposeInventory() {
  const onDisk = readdirSync(REPO_ROOT)
    .filter((name) => /^docker-compose[\w.-]*\.ya?ml$/.test(name))
    .sort();
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const missing = onDisk.filter((name) => !readme.includes(name));
  if (missing.length) {
    fail(
      'README.md',
      null,
      `Compose stacks present but undocumented: ${missing.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 6: a table row must actually be inside a table
// ---------------------------------------------------------------------------

// Rule 3 reads pipe-prefixed lines without rendering Markdown, so it happily
// compared documented Helm defaults in rows that no longer render as a table at
// all: a blockquote inserted between `backend.image.pullPolicy` and the rest of
// the backend parameters ended the table, and every row after it displayed as
// plain text. The checker passed; an operator reading the rendered page lost
// replicas, ports, resources, probes and the import limit out of the table.
//
// A pipe row belongs to a table only if a header separator (`|---|`) appeared
// since the last block boundary. Blank lines inside a table are already illegal
// in GitHub-flavoured Markdown, so the boundary set is: blank line, blockquote,
// heading, fence, or list item.
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/;
const PIPE_ROW = /^\s*\|/;
const BLOCK_BOUNDARY = /^\s*(?:$|>|#{1,6}\s|```|[-*+]\s|\d+\.\s)/;

function checkTableStructure(relative, lines) {
  let inTable = false;
  let fenced = false;

  lines.forEach((text, index) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      inTable = false;
      return;
    }
    if (fenced) return;

    if (TABLE_SEPARATOR.test(text) && index > 0 && PIPE_ROW.test(lines[index - 1])) {
      inTable = true;
      return;
    }
    if (PIPE_ROW.test(text)) {
      // The header row itself precedes the separator; accept it by looking ahead.
      const isHeader =
        index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]);
      if (!inTable && !isHeader) {
        fail(
          relative,
          index + 1,
          'table row outside a table -- a block element ended the table above it, ' +
            'so this row renders as plain text',
        );
      }
      return;
    }
    if (BLOCK_BOUNDARY.test(text)) {
      inTable = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 5: every `npm run <script>` a document offers actually exists
// ---------------------------------------------------------------------------

// The RLS task list documented `npm run rls:ratchet` as a live CI gate long
// after the ratchet had reached zero and its script, baseline and npm entries
// were deleted -- so a reader was pointed at a check that could not be run, let
// alone fail. A command in a document is a promise; this is the check that it
// can be kept.
const NPM_RUN = /npm run ([\w:.-]+)/g;

function collectScriptNames() {
  const names = new Set();
  for (const dir of ['', 'backend', 'frontend', 'e2e']) {
    const manifest = join(REPO_ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const name of Object.keys(scripts)) names.add(name);
  }
  return names;
}

/**
 * Wording that marks a named command as historical rather than runnable. A task
 * list legitimately records "we specified `npm run mny:validate`, shipped as
 * `npm run mny:inspect`"; what it must not do is present a deleted script as a
 * gate you can run. The marker has to be written, so the exemption is a decision
 * rather than an accident, and it is looked for in a window rather than on the
 * one line -- the correction often sits a paragraph below the command.
 */
const SUPERSEDED =
  /superseded|no longer exists?|(?:was |now )?(?:removed|deleted|dropped|gone)|shipped as|renamed to|replaced by/i;
const SUPERSEDED_WINDOW = 8;

function checkNpmScripts(relative, lines, scripts) {
  lines.forEach((text, index) => {
    for (const [, name] of text.matchAll(NPM_RUN)) {
      if (scripts.has(name)) continue;
      const context = lines
        .slice(
          Math.max(0, index - SUPERSEDED_WINDOW),
          index + SUPERSEDED_WINDOW + 1,
        )
        .join('\n');
      if (SUPERSEDED.test(context)) continue;
      fail(relative, index + 1, `npm script does not exist: ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------

const valuesPath = join(REPO_ROOT, 'helm/values.yaml');
const values = existsSync(valuesPath)
  ? flattenValues(readFileSync(valuesPath, 'utf8'))
  : new Map();

if (values.size === 0) {
  fail('helm/values.yaml', null, 'no values parsed -- the defaults check would be vacuous');
}

const npmScripts = collectScriptNames();
if (npmScripts.size === 0) {
  fail('package.json', null, 'no npm scripts parsed -- the script check would be vacuous');
}

for (const relative of DOCS) {
  const lines = readDoc(relative);
  if (!lines) continue;
  checkCommands(relative, lines);
  checkTableStructure(relative, lines);
  if (dirname(relative) === 'helm') checkHelmDefaults(relative, lines, values);
}

for (const relative of new Set([...DOCS, ...allDocsMarkdown()])) {
  const lines = readDoc(relative);
  if (lines) checkNpmScripts(relative, lines, npmScripts);
}

checkComposeInventory();

if (failures.length) {
  console.error('Documentation/manifest drift:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nEvery documented path must exist and every documented Helm default must' +
      '\nmatch helm/values.yaml. See scripts/check-docs-manifests.mjs.',
  );
  process.exit(1);
}

console.log(
  `Documentation/manifest check: OK (${values.size} Helm values, ${DOCS.length} documents)`,
);
