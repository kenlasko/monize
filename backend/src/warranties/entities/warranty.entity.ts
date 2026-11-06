import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";

/** What kind of cover a warranty is; the CSV `WarrantyType` column agrees. */
export type WarrantyKind = "manufacturer" | "extended" | "store" | "other";

export const WARRANTY_KINDS: readonly WarrantyKind[] = [
  "manufacturer",
  "extended",
  "store",
  "other",
];

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

/** A DATE column read as `YYYY-MM-DD` text, never as an instant. */
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
 * One purchased item under warranty (docs/specs/warranty-tracker.md
 * section 6.1). A warranty never moves money: `purchasePrice` is informational
 * and nothing sums it, and the transaction link is ON DELETE SET NULL, so
 * deleting the purchase keeps the warranty.
 *
 * `expiresOn` is the stored fact; status (lifetime, active, expiring, expired)
 * is derived from it and `isLifetime` and never stored. The three CHECK
 * constraints (`chk_warranty_expiry`, `chk_warranty_expiry_after_purchase`,
 * `chk_warranty_price_currency`) are declared in SQL only, as the calendar
 * notes' exclusion constraint is: the RLS spec's generic row seeder builds its
 * rows from these entities and could not satisfy a cross-column rule.
 */
@Entity("warranties")
export class Warranty {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 200 })
  name: string;

  @Column({ type: "varchar", length: 200, name: "vendor_name", nullable: true })
  vendorName: string | null;

  @Column({ type: "uuid", name: "payee_id", nullable: true })
  payeeId: string | null;

  @ManyToOne(() => Payee, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "payee_id" })
  payee?: Payee | null;

  /** The purchase this warranty came from: the parent row, never a split. */
  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ManyToOne(() => Transaction, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction | null;

  @Column({
    type: "varchar",
    length: 100,
    name: "model_number",
    nullable: true,
  })
  modelNumber: string | null;

  @Column({
    type: "text",
    array: true,
    name: "serial_numbers",
    default: () => "'{}'::text[]",
  })
  serialNumbers: string[];

  @Column({
    type: "varchar",
    length: 20,
    name: "warranty_kind",
    default: "manufacturer",
  })
  warrantyKind: WarrantyKind;

  @Column({
    type: "date",
    name: "purchase_date",
    transformer: dateTransformer,
  })
  purchaseDate: string;

  /** NULL only on a lifetime warranty (`chk_warranty_expiry`). */
  @Column({
    type: "date",
    name: "expires_on",
    nullable: true,
    transformer: dateTransformer,
  })
  expiresOn: string | null;

  @Column({ type: "boolean", name: "is_lifetime", default: false })
  isLifetime: boolean;

  /** Set together with `currencyCode` or not at all. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "purchase_price",
    nullable: true,
    transformer: decimalTransformer,
  })
  purchasePrice: number | null;

  @Column({ type: "varchar", length: 3, name: "currency_code", nullable: true })
  currencyCode: string | null;

  @Column({ type: "varchar", length: 500, name: "product_url", nullable: true })
  productUrl: string | null;

  @Column({ type: "varchar", length: 2000, nullable: true })
  notes: string | null;

  @Column({ type: "timestamptz", name: "archived_at", nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
