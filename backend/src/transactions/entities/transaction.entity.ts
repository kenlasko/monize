import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  OneToMany,
  JoinColumn,
  JoinTable,
  Index,
} from "typeorm";
import { Account } from "../../accounts/entities/account.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { Category } from "../../categories/entities/category.entity";
import { Tag } from "../../tags/entities/tag.entity";
import { TransactionSplit } from "./transaction-split.entity";
import { User } from "../../users/entities/user.entity";

import { TransactionStatus } from "./transaction-status.enum";
import { EXTERNAL_ID_INDEX } from "../transaction-external-id";

export { TransactionStatus };

@Entity("transactions")
// Declared here as well as in the migration, because the database-backed suites
// build their schema from the entities: an idempotent create's race is a
// property of this index, and a suite without it would prove nothing.
@Index(EXTERNAL_ID_INDEX, ["accountId", "externalId"], {
  unique: true,
  where: "external_id IS NOT NULL",
})
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  // `database/schema.sql` declares ON DELETE CASCADE; stated here so the
  // entity-built integration schema deletes an account the way production does.
  @ManyToOne(() => Account, (account) => account.transactions, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "account_id" })
  account: Account;

  @Column({
    type: "date",
    name: "transaction_date",
    transformer: {
      // When reading from DB, keep as string to avoid timezone issues
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        // If it's a Date, format as YYYY-MM-DD using local date components
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      // When writing to DB, accept string or Date
      to: (value: string | Date): string | Date => {
        return value;
      },
    },
  })
  transactionDate: string;

  @Column({ type: "uuid", name: "payee_id", nullable: true })
  payeeId: string | null;

  @ManyToOne(() => Payee, { nullable: true })
  @JoinColumn({ name: "payee_id" })
  payee: Payee | null;

  @Column({ type: "varchar", name: "payee_name", length: 255, nullable: true })
  payeeName: string | null;

  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @Column({ type: "varchar", name: "currency_code", length: 3 })
  currencyCode: string;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "exchange_rate",
    default: 1,
  })
  exchangeRate: number;

  // Foreign-currency entry: the amount the user actually paid and the currency
  // they paid in. NULL for an ordinary transaction (amount/currencyCode are the
  // account currency). When set, exchangeRate holds account-currency units per 1
  // unit of originalCurrencyCode and amount ~ round(originalAmount * exchangeRate).
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "original_amount",
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  originalAmount: number | null;

  @Column({
    type: "varchar",
    name: "original_currency_code",
    length: 3,
    nullable: true,
  })
  originalCurrencyCode: string | null;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({
    type: "varchar",
    name: "reference_number",
    length: 100,
    nullable: true,
  })
  referenceNumber: string | null;

  @Column({
    type: "varchar",
    length: 20,
    default: TransactionStatus.UNRECONCILED,
  })
  status: TransactionStatus;

  @Column({
    type: "date",
    name: "reconciled_date",
    nullable: true,
    transformer: {
      from: (value: string | Date | null): string | null => {
        if (!value) return null;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date | null): string | Date | null => value,
    },
  })
  reconciledDate: string | null;

  // Computed properties for backwards compatibility
  get isCleared(): boolean {
    return (
      this.status === TransactionStatus.CLEARED ||
      this.status === TransactionStatus.RECONCILED
    );
  }

  get isReconciled(): boolean {
    return this.status === TransactionStatus.RECONCILED;
  }

  get isVoid(): boolean {
    return this.status === TransactionStatus.VOID;
  }

  @Column({ name: "is_split", default: false })
  isSplit: boolean;

  @Column({ type: "uuid", name: "parent_transaction_id", nullable: true })
  parentTransactionId: string | null;

  @Column({ name: "is_transfer", default: false })
  isTransfer: boolean;

  @Column({ type: "uuid", name: "linked_transaction_id", nullable: true })
  linkedTransactionId: string | null;

  @ManyToOne(() => Transaction, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "linked_transaction_id" })
  linkedTransaction: Transaction | null;

  /**
   * The caller's own key for a row created through the API, or the bank's id
   * for a row imported from an OFX file (`ofx:<FITID>`), unique per account
   * (`idx_transactions_account_external_id`). A create that repeats a key
   * returns the row that already holds it, and an import skips the row; see
   * `transaction-external-id.ts`.
   */
  @Column({ type: "varchar", name: "external_id", length: 255, nullable: true })
  externalId: string | null;

  @Column({ type: "uuid", name: "shared_expense_posting_id", nullable: true })
  sharedExpensePostingId: string | null;

  @OneToMany(() => TransactionSplit, (split) => split.transaction)
  splits: TransactionSplit[];

  @ManyToMany(() => Tag)
  @JoinTable({
    name: "transaction_tags",
    joinColumn: { name: "transaction_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags: Tag[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
