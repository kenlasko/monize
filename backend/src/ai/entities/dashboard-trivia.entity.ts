import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";
import { User } from "../../users/entities/user.entity";
import type { TriviaFigures, TriviaItem } from "../trivia/trivia.types";

@Entity("dashboard_trivia")
export class DashboardTrivia {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @OneToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "jsonb", default: [] })
  items: TriviaItem[];

  @Column({ type: "jsonb", default: {} })
  figures: TriviaFigures;

  /**
   * The language the sentences are in, or the browser's where the reader's
   * preference is to follow it: the daily job has no browser to ask.
   */
  @Column({ type: "varchar", length: 10, nullable: true })
  language: string | null;

  @Column({ name: "generated_at", type: "timestamp" })
  generatedAt: Date;
}
