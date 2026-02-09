import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Exclude } from "class-transformer";
import { User } from "./user.entity";

@Entity("trusted_devices")
export class TrustedDevice {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @Column({ name: "token_hash", type: "varchar", length: 64 })
  @Exclude()
  tokenHash: string;

  @Column({ name: "device_name", type: "varchar", length: 255 })
  deviceName: string;

  @Column({ name: "ip_address", type: "inet", nullable: true })
  ipAddress: string | null;

  @Column({ name: "last_used_at", type: "timestamp" })
  lastUsedAt: Date;

  @Column({ name: "expires_at", type: "timestamp" })
  expiresAt: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user: User;
}
