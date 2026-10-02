import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Account } from "../../accounts/entities/account.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";

/**
 * The ledger behind INV-BANKSYNC-001 (docs/specs/bank-sync.md sections 3, 4 and
 * 7): "this provider transaction was imported into this Monize account".
 * `UNIQUE (account_id, external_key)` is the mechanism that makes an import
 * happen at most once; the row is inserted `ON CONFLICT DO NOTHING` before the
 * transaction row, in the same transaction. It is keyed on the Monize account,
 * not the connection, and `transactionId` is ON DELETE SET NULL so a deleted
 * Monize transaction keeps its ledger row and is not brought back.
 */
@Entity("bank_sync_imported_transactions")
@Unique("uq_bank_sync_imported_transactions_key", ["accountId", "externalKey"])
@Index("idx_bank_sync_imported_transactions_user", ["userId"])
@Index("idx_bank_sync_imported_transactions_transaction", ["transactionId"], {
  where: "transaction_id IS NOT NULL",
})
export class BankSyncImportedTransaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account?: Account;

  /** `ref:` or `hash:` key, at most 255 characters (spec section 6). */
  @Column({ type: "varchar", name: "external_key", length: 255 })
  externalKey: string;

  /** Null after the Monize transaction was deleted. */
  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ManyToOne(() => Transaction, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction | null;

  @Column({
    type: "date",
    name: "booking_date",
    transformer: {
      to: (value: string | Date): string | Date => value,
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      },
    },
  })
  bookingDate: string;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  /**
   * Set when the user added the bank transaction to the exceptions from the
   * preview (spec section 7b): the row then has no transaction, and it claims
   * the key like any ledger row so no later sync imports it. Null is an import.
   */
  @Column({ type: "timestamptz", name: "excluded_at", nullable: true })
  excludedAt: Date | null;
}
