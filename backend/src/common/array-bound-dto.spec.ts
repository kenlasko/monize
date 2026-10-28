import { readdirSync } from "fs";
import { join } from "path";
import { getMetadataStorage } from "class-validator";

/**
 * Guard: a request-supplied array must declare an upper bound.
 *
 * An `@IsArray()` property with no `@ArrayMaxSize` accepts a payload of any
 * size, and whatever iterates it downstream inherits that: a per-element DB
 * write inside one transaction becomes a denial-of-service lever, and CodeQL
 * flags the loop as js/loop-bound-injection (CWE-834). That is how the
 * monte-carlo and delegation reorder endpoints shipped -- the loop moved
 * inside a `withScopedDb` closure during the RLS conversion and nothing
 * bounded the ids driving it.
 *
 * The fix is `@ArrayMaxSize(n)` beside the `@IsArray()`. This test finds the
 * next unbounded array automatically rather than trusting the next author to
 * remember, in the shape of `optional-format-dto.spec.ts`.
 *
 * Metadata-shaped rather than behavioural on purpose: proving the absence of
 * a bound behaviourally means validating an arbitrarily large array, and the
 * `each: true` validators sitting beside `@IsArray()` make that sweep cost
 * proportional to the probe size. class-validator stores every ValidateBy
 * decorator's name (`isArray`, `arrayMaxSize`) in its metadata, which is
 * exactly the claim being checked.
 */

/** Every `*.dto.ts` file under src/, so each one can be imported below. */
function dtoFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".dto.ts")) {
        files.push(path);
      }
    }
  };
  walk(join(__dirname, ".."));
  return files;
}

/**
 * The loaded modules, so their decorators have run and registered metadata.
 *
 * `require` rather than `await import`: the dynamic form makes ts-jest compile
 * every DTO in a separate async tick and the sweep takes minutes. Same
 * exemption the other specs in this repo use for a computed module path.
 */
function dtoModules(): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return dtoFiles().map((path) => require(path));
}

interface ArrayProperty {
  readonly label: string;
  readonly bounded: boolean;
}

/**
 * Every DTO property decorated `@IsArray()`, with whether an `@ArrayMaxSize`
 * sits beside it. Inherited metadata (PartialType, base classes) is included,
 * which a source scan would miss.
 */
function arrayProperties(): ArrayProperty[] {
  const storage = getMetadataStorage();
  const seen = new Set<new () => object>();
  const found = new Map<string, ArrayProperty>();
  for (const module of dtoModules()) {
    for (const exported of Object.values(module as Record<string, unknown>)) {
      if (typeof exported !== "function") continue;
      const cls = exported as new () => object;
      if (seen.has(cls)) continue;
      seen.add(cls);
      const metas = storage.getTargetValidationMetadatas(cls, "", false, false);
      const isArrayProps = new Set(
        metas.filter((m) => m.name === "isArray").map((m) => m.propertyName),
      );
      const boundedProps = new Set(
        metas
          .filter((m) => m.name === "arrayMaxSize")
          .map((m) => m.propertyName),
      );
      for (const property of isArrayProps) {
        found.set(`${cls.name}.${property}`, {
          label: `${cls.name}.${property}`,
          bounded: boundedProps.has(property),
        });
      }
    }
  }
  return [...found.values()];
}

/**
 * Unbounded array properties that predate this guard. Each needs a bound
 * chosen with knowledge of its real payload sizes (a bulk update can
 * legitimately name thousands of transactions; a tag list cannot), so they are
 * grandfathered rather than capped blind. The list may only shrink: add the
 * `@ArrayMaxSize` and remove the entry. New properties never join it.
 */
const PREEXISTING_UNBOUNDED: readonly string[] = [
  "AiQueryDto.conversationHistory",
  "BudgetReportQueryDto.categoryIds",
  "BulkDeleteDto.excludedIds",
  "BulkDeleteDto.transactionIds",
  "BulkUpdateDto.excludedIds",
  "BulkUpdateDto.tagIds",
  "BulkUpdateDto.transactionIds",
  "BulkUpdateFilterDto.accountIds",
  "BulkUpdateFilterDto.categoryIds",
  "BulkUpdateFilterDto.payeeIds",
  "CreateScenarioDto.accountIds",
  "CreateScheduledTransactionDto.tagIds",
  "CreateScheduledTransactionOverrideDto.splits",
  "CreateScheduledTransactionSplitDto.tagIds",
  "CreateSecurityDto.tagIds",
  "CreateTransactionDto.tagIds",
  "CreateTransferDto.tagIds",
  "FilterGroupDto.conditions",
  "MnyImportOptionsDto.accounts",
  "MnyImportOptionsDto.bills",
  "PostScheduledTransactionDto.splits",
  "ReportConfigDto.tableColumns",
  "ReportFiltersDto.accountIds",
  "ReportFiltersDto.categoryIds",
  "ReportFiltersDto.filterGroups",
  "ReportFiltersDto.payeeIds",
  "RunScenarioDto.accountIds",
  "SetGrantsDto.grants",
  "UpdateScenarioDto.accountIds",
  "UpdateScheduledTransactionDto.tagIds",
  "UpdateScheduledTransactionOverrideDto.splits",
  "UpdateSecurityDto.tagIds",
  "UpdateTransactionDto.tagIds",
  "UpdateTransferDto.tagIds",
];

describe("request-supplied arrays declare an upper bound", () => {
  it("finds the @IsArray DTO properties, so the sweep is not vacuous", () => {
    // Were the discovery to break, the sweep below would pass over an empty
    // list and this guard would silently stop guarding.
    expect(arrayProperties().length).toBeGreaterThan(0);
  });

  it("requires @ArrayMaxSize beside every @IsArray not grandfathered above", () => {
    const offenders = arrayProperties()
      .filter((p) => !p.bounded && !PREEXISTING_UNBOUNDED.includes(p.label))
      .map((p) => p.label);
    // Add `@ArrayMaxSize(n)` beside the `@IsArray()`. Do not extend the
    // grandfather list -- it exists for properties older than the guard.
    expect(offenders).toEqual([]);
  });

  it("keeps the grandfather list free of properties that no longer need it", () => {
    // The teeth: an entry that gained its bound (or no longer exists) has to
    // leave the list, so the list can only ever get shorter.
    const unbounded = new Set(
      arrayProperties()
        .filter((p) => !p.bounded)
        .map((p) => p.label),
    );
    const stale = PREEXISTING_UNBOUNDED.filter(
      (label) => !unbounded.has(label),
    );
    expect(stale).toEqual([]);
  });
});
