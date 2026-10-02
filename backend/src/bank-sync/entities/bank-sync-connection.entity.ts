import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import type {
  BankSyncConnectionStatus,
  BankSyncNotifySuccessMode,
  BankSyncProviderName,
  BankSyncPsuType,
} from "../bank-sync.constants";
import { BankSyncAccount } from "./bank-sync-account.entity";

/**
 * One authorization of one user at one institution (docs/specs/bank-sync.md
 * sections 4 and 5). `authStateHash` is the SHA-256 hex of the one-time state;
 * clearing it in the transaction that claims it is what makes a replayed
 * callback find nothing. `externalSessionId` is the provider's session and is
 * never returned to a client.
 * Defaults mirror `database/schema.sql`: the RLS spec builds its schema from
 * these entities.
 */
@Entity("bank_sync_connections")
@Index("idx_bank_sync_connections_user", ["userId"])
@Index("uq_bank_sync_connections_auth_state", ["authStateHash"], {
  unique: true,
  where: "auth_state_hash IS NOT NULL",
})
export class BankSyncConnection {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 30, default: "enable_banking" })
  provider: BankSyncProviderName;

  @Column({ type: "varchar", name: "institution_name", length: 255 })
  institutionName: string;

  /** ISO 3166-1 alpha-2, upper case. */
  @Column({ type: "varchar", name: "institution_country", length: 2 })
  institutionCountry: string;

  @Column({
    type: "varchar",
    name: "psu_type",
    length: 20,
    default: "personal",
  })
  psuType: BankSyncPsuType;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: BankSyncConnectionStatus;

  @Column({
    type: "varchar",
    name: "auth_state_hash",
    length: 64,
    nullable: true,
  })
  authStateHash: string | null;

  @Column({ type: "timestamptz", name: "auth_started_at", nullable: true })
  authStartedAt: Date | null;

  @Column({
    type: "varchar",
    name: "external_session_id",
    length: 255,
    nullable: true,
  })
  externalSessionId: string | null;

  /** When the consent ends at the bank; null until the session exists. */
  @Column({ type: "timestamptz", name: "valid_until", nullable: true })
  validUntil: Date | null;

  @Column({ type: "boolean", name: "auto_sync", default: true })
  autoSync: boolean;

  /** How the daily sync reports a successful run (spec bank-sync-notifications section 3). */
  @Column({
    type: "varchar",
    name: "notify_success",
    length: 20,
    default: "when_imported",
  })
  notifySuccess: BankSyncNotifySuccessMode;

  /**
   * Whether a synced transaction is tagged with the bank's operation type
   * (spec section 7b). On by default.
   */
  @Column({ type: "boolean", name: "tag_operation_type", default: true })
  tagOperationType: boolean;

  @Column({ type: "varchar", name: "last_error", length: 500, nullable: true })
  lastError: string | null;

  @OneToMany(() => BankSyncAccount, (account) => account.connection)
  accounts?: BankSyncAccount[];

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}
