import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("action_history")
export class ActionHistory {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 50, name: "entity_type" })
  entityType: string;

  @Column({ type: "uuid", name: "entity_id", nullable: true })
  entityId: string | null;

  @Column({ type: "varchar", length: 20 })
  action: string;

  @Column({ type: "jsonb", name: "before_data", nullable: true })
  beforeData: Record<string, any> | null;

  @Column({ type: "jsonb", name: "after_data", nullable: true })
  afterData: Record<string, any> | null;

  @Column({ type: "jsonb", name: "related_entities", nullable: true })
  relatedEntities: Record<string, any>[] | null;

  @Column({ type: "boolean", name: "is_undone", default: false })
  isUndone: boolean;

  @Column({ type: "varchar", length: 500 })
  description: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
