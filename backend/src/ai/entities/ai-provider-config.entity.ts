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

const numericTransformer = {
  to: (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "ollama",
  "ollama-cloud",
  "openai-compatible",
] as const;

export type AiProviderType = (typeof AI_PROVIDERS)[number];

/** Providers that are self-hosted and expected to run on private/local networks. */
export const SELF_HOSTED_PROVIDERS: ReadonlySet<AiProviderType> = new Set([
  "ollama",
  "openai-compatible",
]);

@Entity("ai_provider_configs")
export class AiProviderConfig {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 50 })
  provider: AiProviderType;

  @Column({
    type: "varchar",
    length: 100,
    name: "display_name",
    nullable: true,
  })
  displayName: string | null;

  @Column({ name: "is_active", default: true })
  isActive: boolean;

  @Column({ type: "int", default: 0 })
  priority: number;

  @Column({ type: "varchar", length: 100, nullable: true })
  model: string | null;

  @Column({ type: "text", name: "api_key_enc", nullable: true })
  apiKeyEnc: string | null;

  @Column({ type: "varchar", length: 500, name: "base_url", nullable: true })
  baseUrl: string | null;

  @Column({ type: "jsonb", default: {} })
  config: Record<string, unknown>;

  @Column({
    type: "numeric",
    precision: 12,
    scale: 4,
    name: "input_cost_per_1m",
    nullable: true,
    transformer: numericTransformer,
  })
  inputCostPer1M: number | null;

  @Column({
    type: "numeric",
    precision: 12,
    scale: 4,
    name: "output_cost_per_1m",
    nullable: true,
    transformer: numericTransformer,
  })
  outputCostPer1M: number | null;

  @Column({
    type: "varchar",
    length: 3,
    name: "cost_currency",
    default: "USD",
  })
  costCurrency: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
