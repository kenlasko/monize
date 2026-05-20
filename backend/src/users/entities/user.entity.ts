import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
} from "typeorm";
import { Exclude } from "class-transformer";
import { UserPreference } from "./user-preference.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", unique: true, nullable: true })
  email: string | null;

  @Column({ name: "password_hash", type: "varchar", nullable: true })
  @Exclude()
  passwordHash: string | null;

  @Column({ name: "first_name", type: "varchar", nullable: true })
  firstName: string | null;

  @Column({ name: "last_name", type: "varchar", nullable: true })
  lastName: string | null;

  @Column({ name: "auth_provider", default: "local" })
  authProvider: string;

  @Column({
    name: "oidc_subject",
    type: "varchar",
    unique: true,
    nullable: true,
  })
  oidcSubject: string | null;

  @Column({ name: "is_active", default: true })
  isActive: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @Column({ name: "last_login", type: "timestamp", nullable: true })
  lastLogin: Date | null;

  @Column({ name: "reset_token", type: "varchar", nullable: true })
  @Exclude()
  resetToken: string | null;

  @Column({ name: "reset_token_expiry", type: "timestamp", nullable: true })
  @Exclude()
  resetTokenExpiry: Date | null;

  @Column({ type: "varchar", default: "user" })
  role: string;

  @Column({ name: "must_change_password", default: false })
  mustChangePassword: boolean;

  @Column({ name: "two_factor_secret", type: "varchar", nullable: true })
  @Exclude()
  twoFactorSecret: string | null;

  @Column({
    name: "pending_two_factor_secret",
    type: "varchar",
    nullable: true,
  })
  @Exclude()
  pendingTwoFactorSecret: string | null;

  @Column({ name: "failed_login_attempts", type: "int", default: 0 })
  failedLoginAttempts: number;

  @Column({ name: "locked_until", type: "timestamp", nullable: true })
  lockedUntil: Date | null;

  @Column({ name: "backup_codes", type: "text", nullable: true })
  @Exclude()
  backupCodes: string | null;

  @Column({
    name: "oidc_link_pending",
    type: "boolean",
    default: false,
  })
  oidcLinkPending: boolean;

  @Column({
    name: "oidc_link_token",
    type: "varchar",
    nullable: true,
  })
  @Exclude()
  oidcLinkToken: string | null;

  @Column({
    name: "oidc_link_expires_at",
    type: "timestamp",
    nullable: true,
  })
  @Exclude()
  oidcLinkExpiresAt: Date | null;

  @Column({
    name: "pending_oidc_subject",
    type: "varchar",
    nullable: true,
  })
  @Exclude()
  pendingOidcSubject: string | null;

  // True when the row exists solely as an owner-managed delegate identity
  // (created via the Shared Access flow, never claimed via /register).
  // Hides the user from admin User Management and the delegate's own
  // context list. Cleared the moment the row is claimed via /register so
  // the user becomes a full account.
  @Column({ name: "is_delegate_only", type: "boolean", default: false })
  isDelegateOnly: boolean;

  @OneToOne(() => UserPreference, (preference) => preference.user)
  preferences: UserPreference;
}
