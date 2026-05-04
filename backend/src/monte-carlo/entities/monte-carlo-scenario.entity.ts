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

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

@Entity("monte_carlo_scenarios")
export class MonteCarloScenario {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "uuid", array: true, name: "account_ids", default: "{}" })
  accountIds: string[];

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "starting_value",
    default: 0,
    transformer: decimalTransformer,
  })
  startingValue: number;

  @Column({ name: "use_current_balance", default: true })
  useCurrentBalance: boolean;

  @Column({ type: "integer", name: "years_to_retirement" })
  yearsToRetirement: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "annual_contribution",
    default: 0,
    transformer: decimalTransformer,
  })
  annualContribution: number;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 6,
    name: "contribution_growth_rate",
    default: 0,
    transformer: decimalTransformer,
  })
  contributionGrowthRate: number;

  @Column({ type: "integer", name: "years_in_retirement", default: 0 })
  yearsInRetirement: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "annual_withdrawal",
    default: 0,
    transformer: decimalTransformer,
  })
  annualWithdrawal: number;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 6,
    name: "expected_return",
    transformer: decimalTransformer,
  })
  expectedReturn: number;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 6,
    transformer: decimalTransformer,
  })
  volatility: number;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 6,
    name: "inflation_rate",
    default: 0.025,
    transformer: decimalTransformer,
  })
  inflationRate: number;

  @Column({ name: "show_real_values", default: false })
  showRealValues: boolean;

  @Column({ name: "use_historical_returns", default: false })
  useHistoricalReturns: boolean;

  @Column({ type: "integer", name: "simulation_count", default: 5000 })
  simulationCount: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "target_value",
    nullable: true,
    transformer: decimalTransformer,
  })
  targetValue: number | null;

  @Column({ type: "bigint", name: "random_seed", nullable: true })
  randomSeed: string | null;

  @Column({ name: "is_favourite", default: false })
  isFavourite: boolean;

  @Column({ type: "timestamp", name: "last_run_at", nullable: true })
  lastRunAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
