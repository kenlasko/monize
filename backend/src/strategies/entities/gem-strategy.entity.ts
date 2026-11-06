import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { User } from "../../users/entities/user.entity";
import { GemStrategyAccount } from "./gem-strategy-account.entity";
import { GemStrategyAsset } from "./gem-strategy-asset.entity";

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/** How often the strategy re-evaluates its signal. */
export type GemCadence = "MONTHLY" | "QUARTERLY";

/**
 * One GEM (Global Equities Momentum) scenario: how often the signal is
 * evaluated, which accounts it is run in (see GemStrategyAccount), and the cost
 * assumptions behind the transfer estimates the report shows.
 *
 * A user may keep several. Every field here is a modelling choice worth holding
 * two views on at once -- a 12-month window against a 6-month one, US-listed
 * instruments against their UCITS equivalents, or one scenario per account
 * because the tax rate differs. Signals are keyed by strategy, so each keeps
 * its own evaluation history.
 *
 * The strategy rules themselves are not configurable -- only the instruments
 * (see GemStrategyAsset), the cadence and the momentum window are.
 */
@Entity("gem_strategies")
export class GemStrategy {
  @ApiProperty()
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty()
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @ApiProperty({ description: "Scenario name, shown in the report switcher" })
  @Column({ type: "varchar", length: 100, default: "GEM" })
  name: string;

  @ApiProperty({ enum: ["MONTHLY", "QUARTERLY"] })
  @Column({ type: "varchar", length: 20, default: "MONTHLY" })
  cadence: GemCadence;

  @ApiProperty({ description: "Momentum lookback window in months" })
  @Column({ type: "int", name: "lookback_months", default: 12 })
  lookbackMonths: number;

  @ApiProperty({
    required: false,
    description: "Tax rate applied to an estimated realized gain, in percent",
  })
  @Column({
    type: "decimal",
    precision: 9,
    scale: 4,
    name: "tax_rate_percent",
    nullable: true,
    transformer: numericTransformer,
  })
  taxRatePercent: number | null;

  @ApiProperty({
    required: false,
    description:
      "Estimated broker commission per trade. A switch is charged once per " +
      "off-target holding sold plus once for the buy.",
  })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "commission_amount",
    nullable: true,
    transformer: numericTransformer,
  })
  commissionAmount: number | null;

  @ApiProperty({ required: false })
  @Column({
    type: "varchar",
    length: 500,
    name: "rules_source_url",
    nullable: true,
  })
  rulesSourceUrl: string | null;

  @ApiProperty({ required: false })
  @Column({
    type: "varchar",
    length: 100,
    name: "rules_source_label",
    nullable: true,
  })
  rulesSourceLabel: string | null;

  @OneToMany(() => GemStrategyAsset, (asset) => asset.strategy)
  assets: GemStrategyAsset[];

  /** Brokerage accounts the strategy is run in; their holdings are summed. */
  @OneToMany(() => GemStrategyAccount, (link) => link.strategy)
  accounts: GemStrategyAccount[];

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
