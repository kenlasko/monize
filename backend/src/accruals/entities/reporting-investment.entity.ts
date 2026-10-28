/** Read-only relation mapping. Column parity with the source entity is checked by integration tests. */
import {
  InvestmentAction,
  numericTransformer,
} from "../../securities/entities/investment-transaction.entity";
import {
  ViewEntity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Account } from "../../accounts/entities/account.entity";
import { ReportingTransaction } from "./reporting-transaction.entity";
// From the enum's own module, not transaction.entity: the entity import
// closes a require cycle that leaves the enum undefined at decoration time.
import { TransactionStatus } from "../../transactions/entities/transaction-status.enum";
import { ReportingSplit } from "./reporting-split.entity";
import { Security } from "../../securities/entities/security.entity";
import { User } from "../../users/entities/user.entity";
import { BondInstrument } from "../../bonds/entities/bond-instrument.entity";

/**
 * The action vocabulary, including Microsoft Money's full distribution set
 * (issue #1149). Six of these are refinements of a base action: they move
 * shares and cash exactly as their base does, and exist so the *kind* of
 * income survives into the register and future tax reporting instead of being
 * collapsed at import time.
 *
 * | Action | Base | Shares | Cash | Income kind |
 * |---|---|---|---|---|
 * | REINVEST_INTEREST | REINVEST | + | none | interest, reinvested |
 * | REINVEST_CAPITAL_GAIN_SHORT | REINVEST | + | none | short-term gain, reinvested |
 * | REINVEST_CAPITAL_GAIN_LONG | REINVEST | + | none | long-term gain, reinvested |
 * | CAPITAL_GAIN_SHORT | CAPITAL_GAIN | none | in | short-term gain distribution |
 * | CAPITAL_GAIN_LONG | CAPITAL_GAIN | none | in | long-term gain distribution |
 * | REDEEM | SELL | - | in | CD/bond redemption (accrued interest rides on a linked INTEREST companion) |
 *
 * Every financial fold normalizes through `baseInvestmentAction`
 * (`securities/investment-replay.util.ts`) so a refinement cannot behave
 * differently from its base by accident; only income-classification surfaces
 * read the raw value.
 *
 * RETURN_OF_CAPITAL (issue #1800) is a base action of its own, not a
 * refinement: its cash arrives like a DIVIDEND's, but it is not income -- it
 * pays back part of what the shares cost, so it reduces the position's cost
 * basis (`applyReturnOfCapital`), and only what exceeds the basis is a gain.
 * `docs/specs/return-of-capital.md` is the definition.
 */

@ViewEntity({
  name: "accrual_reporting_investment_transactions",
  synchronize: false,
})
export class ReportingInvestment {
  @ApiProperty()
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty()
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @ApiProperty()
  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ApiProperty({
    required: false,
    description:
      "When set, this investment transaction is embedded inside a split transaction; the split's amount is the cash impact and no separate linked cash transaction is created.",
  })
  @Column({ type: "uuid", name: "transaction_split_id", nullable: true })
  transactionSplitId: string | null;

  @ApiProperty({
    required: false,
    description:
      "When set, links the two legs of a security transfer (TRANSFER_OUT <-> TRANSFER_IN). Editing or deleting one leg cascades to the other.",
  })
  @Column({ type: "uuid", name: "linked_transaction_id", nullable: true })
  linkedTransactionId: string | null;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "security_id", nullable: true })
  securityId: string | null;

  @ApiProperty({
    required: false,
    description: "Account where funds come from (BUY) or go to (SELL)",
  })
  @Column({ type: "uuid", name: "funding_account_id", nullable: true })
  fundingAccountId: string | null;

  @ApiProperty({ enum: InvestmentAction })
  @Column({ type: "varchar", length: 50 })
  action: InvestmentAction;

  @ApiProperty()
  @Column({
    type: "date",
    name: "transaction_date",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  transactionDate: string;

  @ApiProperty({ example: 100, description: "Number of shares" })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 8,
    nullable: true,
    transformer: numericTransformer,
  })
  quantity: number | null;

  @ApiProperty({ example: 150.25, description: "Price per share" })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    nullable: true,
    transformer: numericTransformer,
  })
  price: number | null;

  @ApiProperty({ example: 9.99, description: "Commission or fee" })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    default: 0,
    transformer: numericTransformer,
  })
  commission: number;

  @ApiProperty({
    example: 15035.99,
    description: "Total amount of transaction in the security's currency",
  })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "total_amount",
    transformer: numericTransformer,
  })
  totalAmount: number;

  @ApiProperty({
    example: 1.365,
    description:
      "Exchange rate used to convert the total amount from the security's currency into the cash account's currency. Defaults to 1 when both currencies match.",
  })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "exchange_rate",
    default: 1,
    transformer: {
      to: (value: number | null | undefined): number =>
        value === null || value === undefined ? 1 : value,
      from: (value: string | null): number =>
        value === null ? 1 : Number(value),
    },
  })
  exchangeRate: number;

  @ApiProperty({ required: false })
  @Column({ type: "text", nullable: true })
  description: string | null;

  // Same enum as transactions.status, never forked. A VOID investment row
  // moves no shares and no cash, and its linked cash transaction shares the
  // VOID boundary with it. Spec: docs/specs/investment-transaction-status.md.
  @ApiProperty({ enum: TransactionStatus })
  @Column({
    type: "varchar",
    length: 20,
    default: TransactionStatus.UNRECONCILED,
  })
  status: TransactionStatus;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description:
      "The bond series (bond instrument) a share-moving row of a program-linked security acts on. " +
      "An acquisition's is given or inferred from the date; a removal's is optional. Null otherwise.",
  })
  @Column({ type: "uuid", nullable: true, name: "bond_instrument_id" })
  bondInstrumentId: string | null;

  // Declared so the integration schema, built from the entities, carries the
  // `fk_investment_transactions_bond_instrument ... ON DELETE RESTRICT` of the
  // migration. Never loaded; `bondInstrumentId` is what the code reads and writes.
  @ManyToOne(() => BondInstrument, { onDelete: "RESTRICT", nullable: true })
  @JoinColumn({
    name: "bond_instrument_id",
    foreignKeyConstraintName: "fk_investment_transactions_bond_instrument",
  })
  bondInstrument?: BondInstrument | null;

  @ManyToOne(() => Account)
  @JoinColumn({ name: "account_id" })
  account: Account;

  @ManyToOne(() => ReportingTransaction, { nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction: ReportingTransaction;

  @OneToOne(() => ReportingSplit, { nullable: true, onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_split_id" })
  transactionSplit: ReportingSplit | null;

  @ManyToOne(() => Security, { nullable: true })
  @JoinColumn({ name: "security_id" })
  security: Security;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "funding_account_id" })
  fundingAccount: Account | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  /**
   * Accrued interest paid out with a redemption, read from the linked INTEREST
   * companion row. Not a column: the interest is stored as its own investment
   * transaction so it is income to every report without a special case, and
   * this field is the redemption's view of it. `0` when there is no companion.
   * Spec: docs/specs/redemption-accrued-interest.md.
   */
  @ApiProperty({ required: false, example: 87.5 })
  accruedInterest?: number;

  /**
   * The unit each money field above is in, stamped on the row by
   * `attachInvestmentRowCurrencies` so no consumer has to infer it from the
   * account it is filed under. Not columns: they are derived from the loaded
   * `security`, `account` and `fundingAccount` relations, and are absent on a
   * response whose path does not load them -- absent means no information.
   * `investment-transaction-currencies.util.ts` holds the derivation.
   */
  @ApiProperty({ required: false, example: "EUR" })
  amountCurrencyCode?: string | null;

  @ApiProperty({ required: false, example: "EUR" })
  priceCurrencyCode?: string | null;

  @ApiProperty({ required: false, example: "EUR" })
  commissionCurrencyCode?: string | null;

  @ApiProperty({ required: false, example: "PLN" })
  settlementCurrencyCode?: string | null;
}
