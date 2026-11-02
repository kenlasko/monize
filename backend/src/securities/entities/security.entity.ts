import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { User } from "../../users/entities/user.entity";
import { Tag } from "../../tags/entities/tag.entity";
import { BondProgram } from "../../bonds/entities/bond-program.entity";

/** NUMERIC(9,4) comes back from pg as a string; keep it a number. */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity("securities")
@Unique(["userId", "symbol"])
export class Security {
  @ApiProperty({ example: "c5f5d5f0-1234-4567-890a-123456789abc" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ description: "Owner user ID" })
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user: User;

  @ApiProperty({ example: "AAPL", description: "Stock symbol or ticker" })
  @Column({ type: "varchar", length: 20 })
  symbol: string;

  @ApiProperty({
    example: "Apple Inc.",
    description: "Full name of the security",
  })
  @Column({ type: "varchar", length: 255 })
  name: string;

  @ApiProperty({ example: "STOCK", description: "Type of security" })
  @Column({
    type: "varchar",
    length: 50,
    name: "security_type",
    nullable: true,
  })
  securityType: string | null;

  @ApiProperty({ example: "NASDAQ", description: "Stock exchange" })
  @Column({ type: "varchar", length: 50, nullable: true })
  exchange: string | null;

  @ApiProperty({ example: "USD" })
  @Column({ type: "varchar", length: 3, name: "currency_code" })
  currencyCode: string;

  @ApiProperty({
    example: "Global aggregate bond ETF. ~99% bonds, ~1% cash. TER 0.10%.",
    description:
      "Free-text description, optionally pre-filled from the quote provider",
    nullable: true,
  })
  @Column({ type: "text", nullable: true })
  description: string | null;

  @ApiProperty({ example: true })
  @Column({ type: "boolean", default: true, name: "is_active" })
  isActive: boolean;

  @ApiProperty({
    example: false,
    description: "Pinned to the dashboard Favourite Securities widget",
  })
  @Column({ type: "boolean", default: false, name: "is_favourite" })
  isFavourite: boolean;

  @ApiProperty({
    example: false,
    description: "Skip price updates for auto-generated symbols",
  })
  @Column({ type: "boolean", default: false, name: "skip_price_updates" })
  skipPriceUpdates: boolean;

  @ApiProperty({
    nullable: true,
    description:
      "Daily quoted-price movement threshold (%); null disables alerts",
  })
  @Column({
    type: "numeric",
    name: "price_alert_percent",
    precision: 9,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  priceAlertPercent: number | null;

  @ApiProperty({ default: false })
  @Column({ name: "price_chart_enabled", type: "boolean", default: false })
  priceChartEnabled: boolean;

  @ApiProperty({
    example: "Technology",
    description: "Stock sector from Yahoo Finance",
  })
  @Column({ type: "varchar", length: 100, nullable: true })
  sector: string | null;

  @ApiProperty({
    example: "Consumer Electronics",
    description: "Stock industry from Yahoo Finance",
  })
  @Column({ type: "varchar", length: 100, nullable: true })
  industry: string | null;

  @ApiProperty({ description: "ETF sector breakdown array [{sector, weight}]" })
  @Column({ type: "jsonb", nullable: true, name: "sector_weightings" })
  sectorWeightings: { sector: string; weight: number }[] | null;

  @ApiProperty({
    description:
      "Manual ETF/fund country breakdown array [{name, weight}]. weight is a " +
      "decimal 0-1 (same convention as sectorWeightings). A shortfall under 1.0 " +
      "is shown as 'Other' at display/report time and is not stored.",
  })
  @Column({ type: "jsonb", nullable: true, name: "country_weightings" })
  countryWeightings: { name: string; weight: number }[] | null;

  @ApiProperty({
    description:
      "Manual ETF/fund asset-class breakdown array [{name, weight}]. Names are " +
      "free text (the picker offers the ones the user has already used); weight " +
      "is a decimal 0-1. A shortfall under 1.0 is shown as 'Other' at display " +
      "time and is not stored.",
  })
  @Column({ type: "jsonb", nullable: true, name: "asset_weightings" })
  assetWeightings: { name: string; weight: number }[] | null;

  @ApiProperty({ description: "When sector data was last fetched from Yahoo" })
  @Column({ type: "timestamp", nullable: true, name: "sector_data_updated_at" })
  sectorDataUpdatedAt: Date | null;

  @ApiProperty({
    example: "https://www.apple.com",
    description:
      "The issuer's or product's own page. Auto-filled from Yahoo's summaryProfile where the provider has one, which in practice means shares; for ETFs and funds it stays empty unless the user types it.",
    nullable: true,
  })
  @Column({ type: "varchar", length: 2048, nullable: true })
  website: string | null;

  @ApiProperty({
    example: "https://investor.apple.com",
    description:
      "The investor-relations page. Manual by nature: no quote provider publishes one, and deriving it from the domain would produce a link that mostly 404s.",
    nullable: true,
  })
  @Column({ type: "varchar", length: 2048, name: "ir_website", nullable: true })
  irWebsite: string | null;

  @ApiProperty({
    example: "yahoo",
    description:
      "Per-security quote provider override ('yahoo' | 'msn' | 'lse' | 'deutsche_boerse' | 'html_table'); NULL = use user default",
    nullable: true,
  })
  @Column({
    type: "varchar",
    length: 20,
    nullable: true,
    name: "quote_provider",
  })
  // Written-out literals, not the QuoteProviderName alias: entity-varchar-capacity.spec.ts
  // reads this annotation to check the longest value against the column width.
  quoteProvider:
    "yahoo" | "msn" | "lse" | "deutsche_boerse" | "html_table" | null;

  /**
   * The web page whose price table the `html_table` provider reads for this
   * security. Ignored by every other provider.
   */
  @ApiProperty({
    example:
      "https://www.ariva.de/1-unze-kruegerrand-gold-kurs/kurse/historische-kurse",
    nullable: true,
    required: false,
  })
  @Column({ type: "varchar", length: 2048, nullable: true, name: "quote_url" })
  quoteUrl: string | null;

  @ApiProperty({
    example: "a1u3p2",
    description:
      "Cached MSN Financial Instrument ID (SecId); auto-resolved from ticker on first MSN call",
    nullable: true,
  })
  @Column({
    type: "varchar",
    length: 50,
    nullable: true,
    name: "msn_instrument_id",
  })
  msnInstrumentId: string | null;

  /**
   * Last time we asked the quote provider for a multi-year historical
   * backfill. Lets the Monte Carlo "Use historical returns" path skip
   * provider calls when we've already pulled what's available — so
   * selecting the same accounts repeatedly doesn't keep hitting the API.
   */
  @ApiProperty({ required: false })
  @Column({
    type: "timestamp",
    nullable: true,
    name: "historical_backfill_attempted_at",
  })
  historicalBackfillAttemptedAt: Date | null;

  /**
   * Where and when this instrument trades, as reported by the provider rather
   * than guessed from the exchange code -- a code can be an alias, a provider's
   * display name, or free text from an import, and a wrong guess would claim a
   * market is open when it is not. The session times are local to
   * `marketTimezone`. All three are null until a refresh reports them.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({
    type: "varchar",
    length: 64,
    nullable: true,
    name: "market_timezone",
  })
  marketTimezone: string | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "time", nullable: true, name: "market_open_time" })
  marketOpenTime: string | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "time", nullable: true, name: "market_close_time" })
  marketCloseTime: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "The bond program (the product, e.g. EDO; GET /bonds/programs) this security is linked to " +
      "(global catalog row). A linked security is priced by the bond engine only, never by a quote provider.",
  })
  @Column({ type: "uuid", nullable: true, name: "bond_program_id" })
  bondProgramId: string | null;

  @ApiProperty({
    description:
      "Fetch every new series of the linked program automatically (the daily series job).",
  })
  @Column({ type: "boolean", default: false, name: "bond_auto_fetch" })
  bondAutoFetch: boolean;

  // Declared so the integration schema, which is built from the entities, carries
  // the `fk_securities_bond_program ... ON DELETE RESTRICT` of the migration:
  // a program is never deleted from under a security that points at it. Never
  // loaded; `bondProgramId` is what the code reads and writes.
  @ManyToOne(() => BondProgram, { onDelete: "RESTRICT", nullable: true })
  @JoinColumn({
    name: "bond_program_id",
    foreignKeyConstraintName: "fk_securities_bond_program",
  })
  bondProgram?: BondProgram | null;

  @ApiProperty({ description: "User-defined tags classifying this security" })
  @ManyToMany(() => Tag)
  @JoinTable({
    name: "security_tags",
    joinColumn: { name: "security_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags: Tag[];

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
