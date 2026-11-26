import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from "class-validator";
import { ReportQueryDto } from "./report-query.dto";
import { splitCsv } from "../../common/helpers/split-csv";

export const SANKEY_DEPTHS = [1, 2] as const;
export type SankeyDepth = (typeof SANKEY_DEPTHS)[number];

/**
 * The Cash Flow Sankey's scope and depth
 * (`docs/specs/sankey-cash-flow.md` section 6). Absent `accountIds`
 * resolves to the default cash-flow scope (decision 1), which the response
 * echoes as `scopeAccountIds`.
 */
export class CashFlowSankeyQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description:
      "Account ids that make up the cash-flow scope (comma-separated). Defaults to every open chequing, savings, cash, credit card and line of credit account.",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description:
      "1 draws top-level categories and destination classes; 2 adds subcategories and the accounts under each class. Defaults to 1.",
    enum: SANKEY_DEPTHS,
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? value : Number(value)))
  @IsIn(SANKEY_DEPTHS)
  depth?: SankeyDepth;
}

export const SANKEY_NODE_KINDS = [
  "income",
  "hub",
  "expense",
  "child",
  "class",
  "inflow",
  "account",
  "uncategorized",
  "residual",
] as const;
export type SankeyNodeKind = (typeof SANKEY_NODE_KINDS)[number];

export class CashFlowSankeyNode {
  /**
   * Stable id: `income:<categoryId>`, `hub`, `expense:<categoryId>`,
   * `child:<categoryId>`, `class:savings|debt|other_accounts`,
   * `inflow:savings|borrowed|other_accounts`, `account:<accountId>` (or
   * `account:unlinked`), `uncategorized:income|expense`,
   * `residual:unspent|deficit`.
   */
  @ApiProperty({ example: "expense:uuid-123" })
  id: string;

  @ApiProperty({ enum: SANKEY_NODE_KINDS })
  kind: SankeyNodeKind;

  /** An expense category whose converted receipts exceed its payments. */
  @ApiPropertyOptional()
  expenseRefund?: boolean;

  /** The category or account name; an English fallback for the fixed nodes. */
  @ApiProperty({ example: "Groceries" })
  label: string;

  @ApiProperty({ nullable: true })
  categoryId: string | null;

  @ApiProperty({ nullable: true })
  parentCategoryId: string | null;

  @ApiProperty({ nullable: true })
  accountId: string | null;

  @ApiProperty({ nullable: true, example: "#3b82f6" })
  color: string | null;

  /**
   * What flowed through the node, in the response's currency, as a magnitude.
   * `null` while any component could not be converted (SANKEY-004).
   */
  @ApiProperty({ nullable: true, example: 600 })
  total: number | null;

  /** The part of {@link total} that converted. Never shown under "Total". */
  @ApiProperty({ example: 600 })
  knownTotal: number;
}

export class CashFlowSankeyLink {
  @ApiProperty({ example: "hub" })
  source: string;

  @ApiProperty({ example: "expense:uuid-123" })
  target: string;

  @ApiProperty({ nullable: true, example: 600 })
  amount: number | null;

  @ApiProperty({ example: 600 })
  knownAmount: number;
}

export class CashFlowSankeyTotals {
  @ApiProperty({ nullable: true })
  income: number | null;

  @ApiProperty({ nullable: true })
  inflows: number | null;

  @ApiProperty({ nullable: true })
  expenses: number | null;

  @ApiProperty({ nullable: true })
  outflows: number | null;

  /** The arithmetic residual, not a transaction. Null while any total is. */
  @ApiProperty({ nullable: true })
  unspent: number | null;

  /** The arithmetic residual, not a transaction. Null while any total is. */
  @ApiProperty({ nullable: true })
  deficit: number | null;
}

export class CashFlowSankeyKnownTotals {
  @ApiProperty()
  income: number;

  @ApiProperty()
  inflows: number;

  @ApiProperty()
  expenses: number;

  @ApiProperty()
  outflows: number;
}

export class CashFlowSankeyResponse {
  @ApiProperty({ example: "2026-09-01" })
  startDate: string;

  @ApiProperty({ example: "2026-09-30" })
  endDate: string;

  /** Reporting currency every figure is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /** The resolved scope: the request's accounts, or the default echoed. */
  @ApiProperty({ type: [String] })
  scopeAccountIds: string[];

  @ApiProperty({ type: [CashFlowSankeyNode] })
  nodes: CashFlowSankeyNode[];

  /** Hub-centred links; depth 2 adds category children and class accounts. */
  @ApiProperty({ type: [CashFlowSankeyLink] })
  links: CashFlowSankeyLink[];

  @ApiProperty({ type: CashFlowSankeyTotals })
  totals: CashFlowSankeyTotals;

  @ApiProperty({ type: CashFlowSankeyKnownTotals })
  knownTotals: CashFlowSankeyKnownTotals;

  /** Source currencies with no usable rate; empty when the report is complete. */
  @ApiProperty({ type: [String], example: ["USD"] })
  missingCurrencies: string[];

  /** Aggregate rows left out of the figures for want of a rate. */
  @ApiProperty({ example: 0 })
  excludedCount: number;

  /**
   * Provisional transfer legs (an imported estimate of what the other account
   * received or sent) inside the transfer flows that converted. The figures
   * include them; above 0 the page says the diagram holds estimated amounts.
   */
  @ApiProperty({ example: 0 })
  provisionalCount: number;
}
