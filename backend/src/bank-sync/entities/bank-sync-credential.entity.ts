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
import { User } from "../../users/entities/user.entity";
import type { BankSyncProviderName } from "../bank-sync.constants";

/**
 * The provider application a user registered: an application id and an RSA
 * private key, one row per user and provider (docs/specs/bank-sync.md section
 * 4). `privateKeyEnc` is AES-256-GCM ciphertext from `EncryptionService`; no
 * response type carries it (INV-BANKSYNC-002). The column is deliberately not
 * named `api_key_enc`, and the table is excluded from the backup.
 * Defaults mirror `database/schema.sql`: the RLS spec builds its schema from
 * these entities.
 */
@Entity("bank_sync_credentials")
@Unique("uq_bank_sync_credentials_user_provider", ["userId", "provider"])
export class BankSyncCredential {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 30, default: "enable_banking" })
  provider: BankSyncProviderName;

  @Column({ type: "varchar", name: "application_id", length: 100 })
  applicationId: string;

  /** Encrypted with `EncryptionService`; never returned to a client. */
  @Column({ type: "text", name: "private_key_enc" })
  privateKeyEnc: string;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}
