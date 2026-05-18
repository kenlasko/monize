import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { AccountDelegateGrant } from "./account-delegate-grant.entity";

export type DelegationStatus = "pending" | "active" | "revoked";

@Entity("account_delegates")
export class AccountDelegate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "owner_user_id", type: "uuid" })
  ownerUserId: string;

  @Column({ name: "delegate_user_id", type: "uuid" })
  delegateUserId: string;

  @Column({ type: "varchar", length: 20, default: "active" })
  status: DelegationStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @Column({ name: "revoked_at", type: "timestamp", nullable: true })
  revokedAt: Date | null;

  // 2C: per-delegation, per-resource, per-operation capabilities for shared
  // reference data. READ is always allowed; these gate create/edit/delete.
  @Column({ name: "payees_can_create", type: "boolean", default: false })
  payeesCanCreate: boolean;

  @Column({ name: "payees_can_edit", type: "boolean", default: false })
  payeesCanEdit: boolean;

  @Column({ name: "payees_can_delete", type: "boolean", default: false })
  payeesCanDelete: boolean;

  @Column({ name: "categories_can_create", type: "boolean", default: false })
  categoriesCanCreate: boolean;

  @Column({ name: "categories_can_edit", type: "boolean", default: false })
  categoriesCanEdit: boolean;

  @Column({ name: "categories_can_delete", type: "boolean", default: false })
  categoriesCanDelete: boolean;

  @Column({ name: "tags_can_create", type: "boolean", default: false })
  tagsCanCreate: boolean;

  @Column({ name: "tags_can_edit", type: "boolean", default: false })
  tagsCanEdit: boolean;

  @Column({ name: "tags_can_delete", type: "boolean", default: false })
  tagsCanDelete: boolean;

  // 3A: per-delegation READ grants for whole app sections. Gate tab
  // visibility + section read endpoints. Account-scoped data still also
  // requires the per-account grants in account_delegate_grants.
  @Column({ name: "bills_can_read", type: "boolean", default: false })
  billsCanRead: boolean;

  @Column({ name: "investments_can_read", type: "boolean", default: false })
  investmentsCanRead: boolean;

  @Column({ name: "budgets_can_read", type: "boolean", default: false })
  budgetsCanRead: boolean;

  @Column({ name: "reports_can_read", type: "boolean", default: false })
  reportsCanRead: boolean;

  @Column({ name: "ai_can_read", type: "boolean", default: false })
  aiCanRead: boolean;

  @ManyToOne(() => User)
  @JoinColumn({ name: "owner_user_id" })
  owner: User;

  @ManyToOne(() => User)
  @JoinColumn({ name: "delegate_user_id" })
  delegate: User;

  @OneToMany(() => AccountDelegateGrant, (grant) => grant.delegation)
  grants: AccountDelegateGrant[];
}
