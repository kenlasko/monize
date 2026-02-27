import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("ai_usage_logs")
export class AiUsageLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 50 })
  provider: string;

  @Column({ type: "varchar", length: 100 })
  model: string;

  @Column({ type: "varchar", length: 50 })
  feature: string;

  @Column({ type: "int", name: "input_tokens" })
  inputTokens: number;

  @Column({ type: "int", name: "output_tokens" })
  outputTokens: number;

  @Column({ type: "int", name: "duration_ms" })
  durationMs: number;

  @Column({ type: "text", nullable: true })
  error: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
