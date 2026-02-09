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
  @Column({ type: "date", name: "price_date" })
  priceDate: Date;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "open_price",
    nullable: true,
  })
  openPrice: number;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "high_price",
    nullable: true,
  })
  highPrice: number;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "low_price",
    nullable: true,
  })
  lowPrice: number;

  @ApiProperty()
  @Column({ type: "decimal", precision: 20, scale: 4, name: "close_price" })
  closePrice: number;

  @ApiProperty({ required: false })
  @Column({ type: "bigint", nullable: true })
  volume: number;

  @ApiProperty({ required: false })
  @Column({ type: "varchar", length: 50, nullable: true })
  source: string;

  @ManyToOne(() => Security)
  @JoinColumn({ name: "security_id" })
  security: Security;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
