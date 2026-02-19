import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { Budget } from "./budget.entity";
import { BudgetPeriodCategory } from "./budget-period-category.entity";

export enum PeriodStatus {
  OPEN = "OPEN",
  CLOSED = "CLOSED",
  PROJECTED = "PROJECTED",
}

const dateTransformer = {
  from: (value: string | Date): string => {
    if (!value) return value as string;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date) => value,
};

@Entity("budget_periods")
export class BudgetPeriod {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "budget_id" })
  budgetId: string;

  @ManyToOne(() => Budget, (budget) => budget.periods)
  @JoinColumn({ name: "budget_id" })
  budget: Budget;

  @Column({
    type: "date",
    name: "period_start",
    transformer: dateTransformer,
  })
  periodStart: string;

  @Column({
    type: "date",
    name: "period_end",
    transformer: dateTransformer,
  })
  periodEnd: string;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "actual_income",
    default: 0,
  })
  actualIncome: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "actual_expenses",
    default: 0,
  })
  actualExpenses: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "total_budgeted",
    default: 0,
  })
  totalBudgeted: number;

  @Column({
    type: "varchar",
    length: 20,
    default: PeriodStatus.OPEN,
  })
  status: PeriodStatus;

  @OneToMany(() => BudgetPeriodCategory, (bpc) => bpc.budgetPeriod)
  periodCategories: BudgetPeriodCategory[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
