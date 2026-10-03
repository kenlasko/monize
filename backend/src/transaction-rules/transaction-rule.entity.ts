import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Check,
} from "typeorm";
import { User } from "../users/entities/user.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { RuleTrigger } from "./rule-trigger.types";

/**
 * A DATE column read back as its `YYYY-MM-DD` string, never through the
 * server's timezone (the same transformer `budget.entity.ts` uses).
 */
const dateTransformer = {
  from: (value: string | Date | null): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

/**
 * A per-user rule (design section 4). `condition` and `actions` are validated
 * by the application on write (`validateRuleDefinition`); a row restored from a
 * support backup can still hold the column defaults (`{}` and `[]`), which the
 * service reports as invalid rather than throwing.
 *
 * Column defaults mirror `database/migrations/20260928193705_add_transaction_
 * rules.sql`: the RLS spec builds its schema from these entities.
 */
@Entity("transaction_rules")
// Deferrable so a reorder rewrites several positions in one transaction
// without colliding part-way through.
@Unique("uq_transaction_rules_user_position", ["userId", "position"], {
  deferrable: "INITIALLY DEFERRED",
})
// Declared here as well as in schema.sql and the migration, under the same name
// and expression: TypeORM builds the integration harness's database from this
// metadata, so a constraint only schema.sql carries is one an integration spec
// cannot observe (INV-RULE-004: the window is ordered, whatever the DTO missed).
@Check(
  "ck_transaction_rules_active_window",
  "active_from IS NULL OR active_to IS NULL OR active_from <= active_to",
)
export class TransactionRule {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "boolean", default: true })
  enabled: boolean;

  /** Evaluation order, unique per user. */
  @Column({ type: "int" })
  position: number;

  @Column({
    type: "text",
    array: true,
    default: () => "ARRAY['create', 'import']::text[]",
  })
  triggers: RuleTrigger[];

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  condition: RuleConditionNode;

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  actions: RuleAction[];

  @Column({ type: "boolean", name: "stop_processing", default: false })
  stopProcessing: boolean;

  /**
   * The active window (INV-RULE-004): the first and last transaction date,
   * inclusive, the rule is evaluated for. Null is open on that side.
   */
  @Column({
    type: "date",
    name: "active_from",
    nullable: true,
    transformer: dateTransformer,
  })
  activeFrom: string | null;

  @Column({
    type: "date",
    name: "active_to",
    nullable: true,
    transformer: dateTransformer,
  })
  activeTo: string | null;

  /** Compare-and-swap counter for updates. */
  @Column({ type: "int", default: 1 })
  revision: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
