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
import { Account } from "../../accounts/entities/account.entity";
import { User } from "../../users/entities/user.entity";

const dateStringTransformer = {
  from: (value: string | Date | null): string | null => {
    if (value === null || value === undefined) return value as null;
    if (typeof value === "string") return value;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

@Entity("monthly_account_balances")
@Unique(["accountId", "month"])
export class MonthlyAccountBalance {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: "account_id" })
  account: Account;

  @Column({ type: "date", transformer: dateStringTransformer })
  month: string;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    default: 0,
  })
  balance: number;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "market_value",
    nullable: true,
  })
  marketValue: number | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
