import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { CategoryType } from "../category-type.util";

@Entity("categories")
export class Category {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "parent_id", nullable: true })
  parentId: string | null;

  @ManyToOne(() => Category, (category) => category.children, {
    nullable: true,
  })
  @JoinColumn({ name: "parent_id" })
  parent: Category | null;

  @OneToMany(() => Category, (category) => category.parent)
  children: Category[];

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 50, nullable: true })
  icon: string | null;

  @Column({ type: "varchar", length: 7, nullable: true })
  color: string | null;

  /**
   * The category's type, the source of truth. `isIncome` is the previous
   * release's flag, kept one release in step by a trigger and never read by
   * application code (INV-CATEGORY-004); the API's `isIncome` is derived.
   */
  @Column({
    name: "category_type",
    type: "varchar",
    length: 10,
    default: "expense",
  })
  categoryType: CategoryType;

  @Column({ name: "is_income", default: false })
  isIncome: boolean;

  @Column({ name: "auto_sign", type: "boolean", nullable: true })
  autoSign: boolean | null;

  @Column({ name: "is_system", default: false })
  isSystem: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
