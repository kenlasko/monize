import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { MonteCarloScenario } from "./monte-carlo-scenario.entity";

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

export type CashFlowType = "ONE_TIME" | "RECURRING";

@Entity("monte_carlo_cash_flows")
export class MonteCarloCashFlow {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "scenario_id" })
  scenarioId: string;

  @ManyToOne(() => MonteCarloScenario, (s) => s.cashFlows, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "scenario_id" })
  scenario?: MonteCarloScenario;

  @Column({ type: "varchar", length: 255 })
  name: string;

  /** Signed amount: positive for income, negative for expenses. */
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    transformer: decimalTransformer,
  })
  amount: number;

  @Column({ type: "varchar", length: 20, name: "flow_type" })
  flowType: CashFlowType;

  /** Year offset from "today" (1 = first simulated year). */
  @Column({ type: "integer", name: "start_year" })
  startYear: number;

  /** End year for recurring flows, inclusive. null = until horizon ends. */
  @Column({ type: "integer", name: "end_year", nullable: true })
  endYear: number | null;

  /**
   * If true, the amount grows with the scenario's inflation rate each year
   * since startYear (so a recurring expense keeps its real purchasing
   * power). If false, the same nominal amount applies every year.
   */
  @Column({ name: "inflation_adjust", default: true })
  inflationAdjust: boolean;

  @Column({ type: "integer", name: "sort_order", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
