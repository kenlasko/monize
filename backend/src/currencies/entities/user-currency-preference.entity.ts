import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Currency } from "./currency.entity";

@Entity("user_currency_preferences")
export class UserCurrencyPreference {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @PrimaryColumn({ type: "varchar", length: 3, name: "currency_code" })
  currencyCode: string;

  @Column({ type: "boolean", name: "is_active", default: true })
  isActive: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: "currency_code", referencedColumnName: "code" })
  currency: Currency;
}
