import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Account } from "../../accounts/entities/account.entity";
import type { BankSyncLastSyncStatus } from "../bank-sync.constants";
import { BankSyncConnection } from "./bank-sync-connection.entity";

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/** DATE columns stay `YYYY-MM-DD` strings (docs/backend/entities-and-dtos.md). */
const dateStringTransformer = {
  to: (value: string | Date | null): string | Date | null => value,
  from: (value: string | Date | null): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  },
};

/**
 * One account a connection can read, mapped to at most one Monize account
 * (docs/specs/bank-sync.md section 4). `accountId` is ON DELETE SET NULL, and a
 * linked row always has `syncFromDate` (a CHECK in the schema). `bankBalance`
 * is what the bank reported, at money precision; it never writes
 * `accounts.current_balance`. Defaults mirror `database/schema.sql`: the RLS
 * spec builds its schema from these entities.
 */
@Entity("bank_sync_accounts")
@Unique("uq_bank_sync_accounts_connection_external", [
  "connectionId",
  "externalAccountId",
])
@Index("idx_bank_sync_accounts_user", ["userId"])
@Index("uq_bank_sync_accounts_account", ["accountId"], {
  unique: true,
  where: "account_id IS NOT NULL",
})
export class BankSyncAccount {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "connection_id" })
  connectionId: string;

  @ManyToOne(() => BankSyncConnection, (connection) => connection.accounts, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "connection_id" })
  connection?: BankSyncConnection;

  @Column({ type: "varchar", name: "external_account_id", length: 255 })
  externalAccountId: string;

  /** Stable across sessions; what re-authorization matches on. */
  @Column({
    type: "varchar",
    name: "identification_hash",
    length: 255,
    nullable: true,
  })
  identificationHash: string | null;

  @Column({
    type: "varchar",
    name: "display_name",
    length: 255,
    nullable: true,
  })
  displayName: string | null;

  /** Last four characters only, e.g. "**** 1234". */
  @Column({
    type: "varchar",
    name: "identifier_masked",
    length: 50,
    nullable: true,
  })
  identifierMasked: string | null;

  /**
   * The bank account's full identifier (IBAN, else another scheme's number),
   * normalized: spaces and dashes removed, upper case. It is what a Monize
   * account is matched on (spec section 5a) and has the sensitivity of
   * `accounts.account_number`. The view returns it to its owner to prefill an
   * account created from the bank account; lists show `identifier_masked`.
   */
  @Column({
    type: "varchar",
    name: "account_identifier",
    length: 64,
    nullable: true,
  })
  accountIdentifier: string | null;

  /** The provider's cash account type (`CACC`, `CARD`, `SVGS`, ...), upper case. */
  @Column({
    type: "varchar",
    name: "cash_account_type",
    length: 10,
    nullable: true,
  })
  cashAccountType: string | null;

  /** Null when the provider did not say; each row is then checked on its own. */
  @Column({
    type: "varchar",
    name: "currency_code",
    length: 3,
    nullable: true,
  })
  currencyCode: string | null;

  /** The Monize account this bank account feeds; null while unlinked. */
  @Column({ type: "uuid", name: "account_id", nullable: true })
  accountId: string | null;

  @ManyToOne(() => Account, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "account_id" })
  account?: Account | null;

  /** The cut-off date: rows booked before it are never imported. */
  @Column({
    type: "date",
    name: "sync_from_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  syncFromDate: string | null;

  @Column({ type: "timestamptz", name: "last_synced_at", nullable: true })
  lastSyncedAt: Date | null;

  @Column({ type: "timestamptz", name: "last_success_at", nullable: true })
  lastSuccessAt: Date | null;

  @Column({
    type: "varchar",
    name: "last_sync_status",
    length: 20,
    nullable: true,
  })
  lastSyncStatus: BankSyncLastSyncStatus | null;

  @Column({
    type: "varchar",
    name: "last_sync_error",
    length: 500,
    nullable: true,
  })
  lastSyncError: string | null;

  @Column({ type: "integer", name: "last_imported_count", default: 0 })
  lastImportedCount: number;

  @Column({ type: "integer", name: "last_skipped_count", default: 0 })
  lastSkippedCount: number;

  @Column({ type: "integer", name: "last_refused_count", default: 0 })
  lastRefusedCount: number;

  /** Null means the bank did not report one; never 0. */
  @Column({
    type: "decimal",
    name: "bank_balance",
    precision: 20,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  bankBalance: number | null;

  @Column({
    type: "varchar",
    name: "bank_balance_currency",
    length: 3,
    nullable: true,
  })
  bankBalanceCurrency: string | null;

  @Column({
    type: "date",
    name: "bank_balance_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  bankBalanceDate: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}
