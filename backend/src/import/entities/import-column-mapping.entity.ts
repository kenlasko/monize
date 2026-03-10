import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("import_column_mappings")
export class ImportColumnMapping {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "jsonb", name: "column_mappings" })
  columnMappings: Record<string, unknown>;

  @Column({ type: "jsonb", name: "transfer_rules", default: "[]" })
  transferRules: Record<string, unknown>[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
