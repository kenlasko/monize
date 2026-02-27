import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { BudgetCategory } from "./budget-category.entity";
import { BudgetPeriod } from "./budget-period.entity";
import { User } from "../../users/entities/user.entity";

export enum BudgetType {
  MONTHLY = "MONTHLY",
  ANNUAL = "ANNUAL",
  PAY_PERIOD = "PAY_PERIOD",
}

export enum BudgetStrategy {
  FIXED = "FIXED",
  ROLLOVER = "ROLLOVER",
  ZERO_BASED = "ZERO_BASED",
  FIFTY_THIRTY_TWENTY = "FIFTY_THIRTY_TWENTY",
}

export interface BudgetConfig {
  includeTransfers?: boolean;
  excludedAccountIds?: string[];
  fiscalYearStart?: number;
  payFrequency?: "WEEKLY" | "BIWEEKLY" | "SEMIMONTHLY" | "MONTHLY";
  payDayOfMonth?: number;
  alertDefaults?: {
    warnAt?: number;
    criticalAt?: number;
  };
}

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

const dateTransformer = {
  from: (value: string | Date | null): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

@Entity("budgets")
export class Budget {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({
    type: "varchar",
    length: 20,
    name: "budget_type",
    default: BudgetType.MONTHLY,
  })
  budgetType: BudgetType;

  @Column({
    type: "date",
    name: "period_start",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date) => value,
    },
  })
  periodStart: string;

  @Column({
    type: "date",
    name: "period_end",
    nullable: true,
    transformer: dateTransformer,
  })
  periodEnd: string | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "base_income",
    nullable: true,
    transformer: decimalTransformer,
  })
  baseIncome: number | null;

  @Column({ name: "income_linked", default: false })
  incomeLinked: boolean;

  @Column({
    type: "varchar",
    length: 30,
    default: BudgetStrategy.FIXED,
  })
  strategy: BudgetStrategy;

  @Column({ name: "is_active", default: true })
  isActive: boolean;

  @Column({ type: "varchar", length: 3, name: "currency_code" })
  currencyCode: string;

  @Column({ type: "jsonb", default: {} })
  config: BudgetConfig;

  @OneToMany(() => BudgetCategory, (bc) => bc.budget)
  categories: BudgetCategory[];

  @OneToMany(() => BudgetPeriod, (bp) => bp.budget)
  periods: BudgetPeriod[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
