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

  @OneToOne(() => UserPreference, (preference) => preference.user)
  preferences: UserPreference;
}
