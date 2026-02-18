import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from "typeorm";

export const INSIGHT_TYPES = [
  "anomaly",
  "trend",
  "subscription",
  "budget_pace",
  "seasonal",
  "new_recurring",
] as const;

export type InsightType = (typeof INSIGHT_TYPES)[number];

export const INSIGHT_SEVERITIES = ["info", "warning", "alert"] as const;

export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

@Entity("ai_insights")
export class AiInsight {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @Column({ type: "varchar", length: 50 })
  type: InsightType;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  description: string;

  @Column({ type: "varchar", length: 20 })
  severity: InsightSeverity;

  @Column({ type: "jsonb", default: {} })
  data: Record<string, unknown>;

  @Column({ name: "is_dismissed", default: false })
  isDismissed: boolean;

  @Column({ name: "generated_at", type: "timestamp" })
  generatedAt: Date;

  @Column({ name: "expires_at", type: "timestamp" })
  expiresAt: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
