import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { ScheduledTransaction } from "./scheduled-transaction.entity";

/**
 * One posted occurrence of a scheduled transaction.
 *
 * The occurrence -- not the schedule -- is the thing that must happen once.
 * Before this table existed there was no name for it: the hourly cron fires in
 * every replica, `post()` read the due row without a claim, and the financial
 * transaction committed in its own transaction *before* `nextDueDate` advanced.
 * Two replicas, or a manual post racing the cron, or a crash between the two
 * commits, each produced the same result -- one bill paid twice (audit P4-004).
 *
 * `(scheduled_transaction_id, original_due_date)` is that name. Manual and
 * automatic posting both insert it, inside the same transaction as the money
 * they create, so the unique key arbitrates and the loser writes nothing.
 * `original_due_date` is the schedule's own `next_due_date` at the moment of
 * posting -- the occurrence's identity -- not the date the row was booked on,
 * which an override or an inline `transactionDate` can move.
 */
@Entity("scheduled_transaction_postings")
@Index(["scheduledTransactionId", "originalDueDate"], { unique: true })
export class ScheduledTransactionPosting {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "scheduled_transaction_id" })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "scheduled_transaction_id" })
  scheduledTransaction?: ScheduledTransaction;

  /** The occurrence's identity: the schedule's due date when it was posted. */
  @Column({
    type: "date",
    name: "original_due_date",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  originalDueDate: string;

  /** The date the money was actually booked on, after overrides. */
  @Column({
    type: "date",
    name: "posted_date",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  postedDate: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
