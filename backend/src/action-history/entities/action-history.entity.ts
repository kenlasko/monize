import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Exclude } from "class-transformer";
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

  @Exclude()
  @Column({ type: "jsonb", name: "before_data", nullable: true })
  beforeData: Record<string, any> | null;

  @Exclude()
  @Column({ type: "jsonb", name: "after_data", nullable: true })
  afterData: Record<string, any> | null;

  @Exclude()
  @Column({ type: "jsonb", name: "related_entities", nullable: true })
  relatedEntities: Record<string, any>[] | null;

  @Column({ type: "boolean", name: "is_undone", default: false })
  isUndone: boolean;

  @Column({ type: "varchar", length: 500 })
  description: string;

  // Localization fields. `description` above is the English source string kept
  // for backward compatibility and as a fallback; the client renders the
  // localized text from this stable key plus its interpolation params so the
  // history always reads in the viewer's current language. Both are exposed to
  // the client (unlike the bulky before/after snapshots above).
  @Column({
    type: "varchar",
    length: 100,
    name: "description_key",
    nullable: true,
  })
  descriptionKey: string | null;

  @Column({ type: "jsonb", name: "description_params", nullable: true })
  descriptionParams: Record<string, any> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
