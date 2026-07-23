/**
 * Self-test for the RLS ratchet (`rls-ratchet.mjs`). Runs under `node --test`
 * (not jest) since it exercises an ESM build script, not app code.
 *
 *   node --test scripts/rls-ratchet.test.mjs   (npm run rls:ratchet:test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATTERNS,
  countOccurrences,
  isExcluded,
  evaluate,
  computeCounts,
} from "./rls-ratchet.mjs";

const injectRe = () => /@InjectRepository\(/g;
const cqrRe = () => /createQueryRunner\(/g;

test("countOccurrences counts every call site, including multiple per line", () => {
  assert.equal(
    countOccurrences("@InjectRepository(A) @InjectRepository(B)", injectRe()),
    2,
  );
  assert.equal(countOccurrences("x.createQueryRunner();", cqrRe()), 1);
  assert.equal(countOccurrences("no tokens here", injectRe()), 0);
  // The bare import must NOT match (no `@` and no `(` adjacent).
  assert.equal(
    countOccurrences('import { InjectRepository } from "@nestjs/typeorm";', injectRe()),
    0,
  );
});

test("isExcluded skips tests, type decls, and tenant-tx.ts but keeps services", () => {
  assert.equal(isExcluded("accounts/accounts.service.ts"), false);
  assert.equal(isExcluded("accounts/accounts.service.spec.ts"), true);
  assert.equal(isExcluded("common/db/tenant-tx.ts"), true);
  assert.equal(isExcluded("common/db/tenant-tx.spec.ts"), true);
  assert.equal(isExcluded("types/foo.d.ts"), true);
  assert.equal(isExcluded("__tests__/helper.ts"), true);
  assert.equal(isExcluded("test/factory.ts"), true);
});

test("evaluate passes only on an exact match", () => {
  const baseline = { injectRepository: 251, createQueryRunner: 61 };
  const { ok, results } = evaluate(
    { injectRepository: 251, createQueryRunner: 61 },
    baseline,
  );
  assert.equal(ok, true);
  assert.ok(results.every((r) => r.status === "ok"));
});

test("evaluate fails when a count increases (adding one banned site)", () => {
  const baseline = { injectRepository: 251, createQueryRunner: 61 };
  const { ok, results } = evaluate(
    { injectRepository: 252, createQueryRunner: 61 },
    baseline,
  );
  assert.equal(ok, false);
  const inject = results.find((r) => r.key === "injectRepository");
  assert.equal(inject.status, "regression");
});

test("evaluate fails when the baseline is stale (sites removed, baseline not lowered)", () => {
  const baseline = { injectRepository: 251, createQueryRunner: 61 };
  const { ok, results } = evaluate(
    { injectRepository: 251, createQueryRunner: 55 },
    baseline,
  );
  assert.equal(ok, false);
  const cqr = results.find((r) => r.key === "createQueryRunner");
  assert.equal(cqr.status, "stale");
});

test("evaluate fails when a baseline is set below the actual count (over-claiming)", () => {
  // Baseline claims fewer sites than really exist -> the true count exceeds it.
  const { ok, results } = evaluate(
    { injectRepository: 251, createQueryRunner: 61 },
    { injectRepository: 240, createQueryRunner: 61 },
  );
  assert.equal(ok, false);
  assert.equal(
    results.find((r) => r.key === "injectRepository").status,
    "regression",
  );
});

test("evaluate flags a missing baseline entry", () => {
  const { ok, results } = evaluate(
    { injectRepository: 251, createQueryRunner: 61 },
    { injectRepository: 251 },
  );
  assert.equal(ok, false);
  assert.equal(
    results.find((r) => r.key === "createQueryRunner").status,
    "missing",
  );
});

test("computeCounts honors exclusions on a fixture tree", () => {
  const root = mkdtempSync(join(tmpdir(), "rls-ratchet-"));
  writeFileSync(
    join(root, "one.ts"),
    "@InjectRepository(A)\n@InjectRepository(B)\nx.createQueryRunner();\n",
  );
  // Excluded: a spec file with tokens must not be counted.
  writeFileSync(join(root, "one.spec.ts"), "@InjectRepository(Z)\n");
  // Excluded: tenant-tx.ts at its canonical relative path.
  mkdirSync(join(root, "common", "db"), { recursive: true });
  writeFileSync(
    join(root, "common", "db", "tenant-tx.ts"),
    "@InjectRepository(Q) x.createQueryRunner();\n",
  );

  const counts = computeCounts(root);
  assert.deepEqual(counts, { injectRepository: 2, createQueryRunner: 1 });
});

test("PATTERNS covers exactly the two tracked tokens", () => {
  assert.deepEqual(
    PATTERNS.map((p) => p.key).sort(),
    ["createQueryRunner", "injectRepository"],
  );
});
