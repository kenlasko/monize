import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  Check,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { AccrualSchedule } from "./accrual-schedule.entity";

/** Decimal columns remain strings so the allocation total never loses precision. */
@Entity("accrual_allocations")
@Unique("uq_accrual_allocation_period", ["scheduleId", "periodIndex"])
@Index("idx_accrual_allocation_user_date", ["userId", "recognitionDate"])
@Check("ck_accrual_allocation_period", "period_index BETWEEN 0 AND 599")
@Check(
  "ck_accrual_allocation_date",
  "recognition_date >= DATE '0001-01-01' AND recognition_date <= DATE '9999-12-31' AND (recognition_date = (date_trunc('month', recognition_date::timestamp) + INTERVAL '1 month - 1 day')::date OR ((EXTRACT(DAY FROM recognition_date) = 1 AND EXTRACT(ISODOW FROM recognition_date) BETWEEN 1 AND 5) OR (EXTRACT(DAY FROM recognition_date) IN (2, 3) AND EXTRACT(ISODOW FROM recognition_date) = 1)))",
)
export class AccrualAllocationEntity {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "user_id", type: "uuid" }) userId: string;
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;
  @Column({ name: "schedule_id", type: "uuid" }) scheduleId: string;
  @ManyToOne(() => AccrualSchedule, { onDelete: "CASCADE" })
  @JoinColumn([
    { name: "schedule_id", referencedColumnName: "id" },
    { name: "user_id", referencedColumnName: "userId" },
  ])
  schedule?: AccrualSchedule;
  @Column({ name: "period_index", type: "integer" }) periodIndex: number;
  @Column({ name: "recognition_date", type: "date" }) recognitionDate: string;
  @Column({ type: "decimal", precision: 20, scale: 4 }) amount: string;
}
