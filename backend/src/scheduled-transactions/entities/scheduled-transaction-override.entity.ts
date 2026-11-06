import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ScheduledTransaction } from "./scheduled-transaction.entity";
import { Category } from "../../categories/entities/category.entity";

/**
 * Represents an override for a specific occurrence of a scheduled transaction.
 * Allows users to modify individual upcoming instances without changing the base template.
 */
@Entity("scheduled_transaction_overrides")
/**
 * One override per recurrence slot, declared HERE as well as in `schema.sql` and
 * migration 168.
 *
 * Not redundancy: the two build paths are different. Production runs
 * `schema.sql` then the migrations, but `synchronize: true` -- which the
 * integration suite uses (`backend/test/helpers/test-database.ts`, and
 * `rls-setup.ts` applies only the migrations carrying RLS/trigger/function
 * markers) -- builds tables from these decorators alone. Declared only in SQL,
 * the constraint did not exist in any test database, so `createOverride`'s
 * concurrent-create refusal was unreachable there and the property "the database
 * is the mechanism" could not be tested at all, only asserted about a file.
 */
@Unique("uq_sched_txn_overrides_occurrence", [
  "scheduledTransactionId",
  "originalDate",
])
export class ScheduledTransactionOverride {
  @ApiProperty({ example: "uuid", description: "Unique identifier" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({
    description: "The scheduled transaction this override applies to",
  })
  @Column({ type: "uuid", name: "scheduled_transaction_id" })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, (st) => st.overrides, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "scheduled_transaction_id" })
  scheduledTransaction: ScheduledTransaction;

  @ApiProperty({
    example: "2024-01-15",
    description:
      "The original calculated occurrence date this override replaces",
  })
  @Column({ type: "date", name: "original_date" })
  originalDate: string;

  @ApiProperty({
    example: "2024-01-15",
    description:
      "The actual date for this occurrence (may differ from originalDate if date was changed)",
  })
  @Column({ type: "date", name: "override_date" })
  overrideDate: string;

  @ApiPropertyOptional({
    example: -150.0,
    description: "Overridden amount (null to use base amount)",
  })
  @Column({ type: "decimal", precision: 24, scale: 8, nullable: true })
  amount: number | null;

  @ApiPropertyOptional({
    description: "Overridden category ID (null to use base category)",
  })
  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @ApiPropertyOptional({ description: "Overridden description" })
  @Column({ type: "text", nullable: true })
  description: string | null;

  @ApiPropertyOptional({
    description: "Whether this override uses splits (overrides base isSplit)",
  })
  @Column({ type: "boolean", name: "is_split", nullable: true })
  isSplit: boolean | null;

  @ApiPropertyOptional({ description: "JSON array of split overrides" })
  @Column({ type: "jsonb", nullable: true })
  splits: OverrideSplit[] | null;

  @ApiPropertyOptional({
    description: "Per-occurrence investment quantity (null to use base value)",
  })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 8,
    name: "investment_quantity",
    nullable: true,
  })
  investmentQuantity: number | null;

  @ApiPropertyOptional({
    description: "Per-occurrence investment price (null to use base value)",
  })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "investment_price",
    nullable: true,
  })
  investmentPrice: number | null;

  @ApiPropertyOptional({
    description:
      "Per-occurrence investment total amount, used for amount-only actions (DIVIDEND/INTEREST/CAPITAL_GAIN)",
  })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "investment_total_amount",
    nullable: true,
  })
  investmentTotalAmount: number | null;

  @ApiProperty({ description: "When this override was created" })
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @ApiProperty({ description: "When this override was last updated" })
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

/**
 * Structure for split overrides stored in the JSON column.
 *
 * Optional `splitKind` and `investment` fields lets a per-occurrence
 * override carry an investment action (BUY/SELL/etc) when the parent
 * scheduled transaction lives on an INVESTMENT_CASH account.
 */
export interface OverrideSplit {
  // Stable identity for this override split (issue #1167 F4). Generated when the
  // override is written and returned in the read model, so a later edit can echo
  // it as `sourceSplitId` and the server correlates FX-rate provenance by identity
  // rather than by matching rate values (which collide across same-security lines).
  id?: string;
  splitKind?: "category" | "transfer" | "investment";
  categoryId: string | null;
  transferAccountId?: string | null;
  investment?: {
    action: string;
    securityId?: string;
    quantity?: number;
    price?: number;
    commission?: number;
    exchangeRate?: number;
    // Currency pair the stored `exchangeRate` was resolved for (issue #1167).
    // Derived server-side when the rate is freshly resolved (override create);
    // posting reuses the rate only when this pair still matches the current
    // settlement pair. Absent means unknown -- an unknown pair is re-resolved at
    // posting, not trusted.
    exchangeRateFromCurrency?: string;
    exchangeRateToCurrency?: string;
  };
  amount: number;
  memo?: string | null;
}
