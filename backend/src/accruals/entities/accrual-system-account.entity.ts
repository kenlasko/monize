import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Check,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Currency } from "../../currencies/entities/currency.entity";
import type { AccrualFamily } from "../accrual-balance";

/** Protected identities for derived timing balances, never cash-ledger accounts. */
@Entity("accrual_system_accounts")
@Unique("uq_accrual_system_identity", ["userId", "family", "currencyCode"])
@Check("ck_accrual_system_family", "family IN ('expense', 'income')")
export class AccrualSystemAccount {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "user_id", type: "uuid" }) userId: string;
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;
  @Column({ type: "varchar", length: 10 }) family: AccrualFamily;
  @Column({ name: "currency_code", type: "varchar", length: 3 })
  currencyCode: string;
  @ManyToOne(() => Currency)
  @JoinColumn({ name: "currency_code", referencedColumnName: "code" })
  currency?: Currency;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
