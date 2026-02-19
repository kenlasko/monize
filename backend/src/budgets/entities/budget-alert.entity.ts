import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Budget } from "./budget.entity";
import { BudgetCategory } from "./budget-category.entity";

export enum AlertType {
  PACE_WARNING = "PACE_WARNING",
  THRESHOLD_WARNING = "THRESHOLD_WARNING",
  THRESHOLD_CRITICAL = "THRESHOLD_CRITICAL",
  OVER_BUDGET = "OVER_BUDGET",
  FLEX_GROUP_WARNING = "FLEX_GROUP_WARNING",
  SEASONAL_SPIKE = "SEASONAL_SPIKE",
  PROJECTED_OVERSPEND = "PROJECTED_OVERSPEND",
  INCOME_SHORTFALL = "INCOME_SHORTFALL",
  POSITIVE_MILESTONE = "POSITIVE_MILESTONE",
}

export enum AlertSeverity {
  INFO = "info",
  WARNING = "warning",
  CRITICAL = "critical",
  SUCCESS = "success",
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

@Entity("budget_alerts")
export class BudgetAlert {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @Column({ type: "uuid", name: "budget_id" })
  budgetId: string;

  @ManyToOne(() => Budget)
  @JoinColumn({ name: "budget_id" })
  budget: Budget;

  @Column({ type: "uuid", name: "budget_category_id", nullable: true })
  budgetCategoryId: string | null;

  @ManyToOne(() => BudgetCategory, { nullable: true })
  @JoinColumn({ name: "budget_category_id" })
  budgetCategory: BudgetCategory | null;

  @Column({ type: "varchar", length: 30, name: "alert_type" })
  alertType: AlertType;

  @Column({ type: "varchar", length: 20 })
  severity: AlertSeverity;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  message: string;

  @Column({ type: "jsonb", default: {} })
  data: Record<string, unknown>;

  @Column({ name: "is_read", default: false })
  isRead: boolean;

  @Column({ name: "is_email_sent", default: false })
  isEmailSent: boolean;

  @Column({
    type: "date",
    name: "period_start",
    transformer: dateTransformer,
  })
  periodStart: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
