import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Security } from "./security.entity";

@Entity("security_prices")
@Unique(["securityId", "priceDate"])
export class SecurityPrice {
  @ApiProperty()
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id: number;

  @ApiProperty()
  @Column({ type: "uuid", name: "security_id" })
  securityId: string;

  @ApiProperty()
  @Column({
    type: "date",
    name: "price_date",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  priceDate: string;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "open_price",
    nullable: true,
  })
  openPrice: number;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "high_price",
    nullable: true,
  })
  highPrice: number;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "low_price",
    nullable: true,
  })
  lowPrice: number;

  @ApiProperty()
  @Column({ type: "decimal", precision: 24, scale: 10, name: "close_price" })
  closePrice: number;

  /**
   * Total-return adjusted close (split + dividend adjusted). Populated from
   * provider data when available. Used for historical mean / volatility
   * calculations so dividends are reflected in the return.
   */
  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "adjusted_close",
    nullable: true,
  })
  adjustedClose: number | null;

  @ApiProperty({ required: false })
  @Column({ type: "bigint", nullable: true })
  volume: number;

  @ApiProperty({ required: false })
  @Column({ type: "varchar", length: 50, nullable: true })
  source: string;

  /**
   * The instant the provider says the quote was struck, as opposed to
   * `priceDate` (the calendar day it belongs to) or `createdAt` (when this row
   * was first written, which does not advance when a same-day refresh updates
   * it in place). Null for manual entries, rows derived from transactions, and
   * everything written before the column existed.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "timestamptz", name: "quoted_at", nullable: true })
  quotedAt: Date | null;

  /**
   * The instant a provider refresh last wrote this row, on insert and on every
   * same-day update, which is what "last updated" means to the reader. Null for
   * manual entries, rows derived from transactions, and everything written
   * before the column existed.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "timestamptz", name: "refreshed_at", nullable: true })
  refreshedAt: Date | null;

  @ManyToOne(() => Security)
  @JoinColumn({ name: "security_id" })
  security: Security;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
