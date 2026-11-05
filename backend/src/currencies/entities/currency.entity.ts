import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Exclude } from "class-transformer";

/**
 * What a currency is (`docs/specs/crypto-accounts.md`, decision 1). The kind is
 * the reader's statement, never inferred from the code: a non-ISO code may be a
 * fiat currency ISO retired, and a coin may take any three letters. The CHECK
 * `currencies_kind_check` holds the database to this list.
 */
export const CURRENCY_KINDS = ["FIAT", "CRYPTO"] as const;

export type CurrencyKind = (typeof CURRENCY_KINDS)[number];

/** The kind of every row that does not say otherwise (the column default). */
export const DEFAULT_CURRENCY_KIND: CurrencyKind = "FIAT";

/**
 * The two CHECKs `database/schema.sql` declares on `currencies`, by the same
 * names, so a schema built from the entities (the integration suite's) refuses
 * what the real one refuses. `currency.entity.spec.ts` holds them to
 * `schema.sql`.
 */
export const CURRENCY_KIND_CHECK = `"kind" IN ('FIAT', 'CRYPTO')`;
export const CURRENCY_QUOTE_SYMBOL_CHECK = `"kind" = 'CRYPTO' OR "quote_symbol" IS NULL`;

@Entity("currencies")
@Check("currencies_kind_check", CURRENCY_KIND_CHECK)
@Check("currencies_quote_symbol_crypto_only", CURRENCY_QUOTE_SYMBOL_CHECK)
export class Currency {
  @ApiProperty({ example: "CAD" })
  @PrimaryColumn({ type: "varchar", length: 3 })
  code: string;

  @ApiProperty({ example: "Canadian Dollar" })
  @Column({ type: "varchar", length: 100 })
  name: string;

  @ApiProperty({ example: "$" })
  @Column({ type: "varchar", length: 10 })
  symbol: string;

  @ApiProperty({ example: 2 })
  @Column({ type: "smallint", name: "decimal_places", default: 2 })
  decimalPlaces: number;

  @ApiProperty({ example: true })
  @Column({ type: "boolean", name: "is_active", default: true })
  isActive: boolean;

  // Another user's id: never part of a response body. Services read it from the
  // instance; the global ClassSerializerInterceptor drops it on the way out.
  @Exclude()
  @Column({ type: "uuid", name: "created_by_user_id", nullable: true })
  createdByUserId: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty({ example: "FIAT", enum: CURRENCY_KINDS })
  @Column({ type: "varchar", length: 10, default: DEFAULT_CURRENCY_KIND })
  kind: CurrencyKind;

  /**
   * The Yahoo `<COIN>-<FIAT>` symbol a CRYPTO currency is priced from
   * (`BTC-EUR`); null on every FIAT row (CHECK
   * `currencies_quote_symbol_crypto_only`) and on a coin no provider quotes.
   */
  @ApiProperty({ example: null, nullable: true, type: String })
  @Column({ type: "varchar", length: 20, name: "quote_symbol", nullable: true })
  quoteSymbol: string | null;
}
