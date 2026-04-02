import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("auto_backup_settings")
export class AutoBackupSettings {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ name: "folder_path", length: 1024, default: "" })
  folderPath: string;

  @Column({ length: 20, default: "daily" })
  frequency: string;

  @Column({ name: "backup_time", length: 5, default: "02:00" })
  backupTime: string;

  @Column({ length: 100, default: "UTC" })
  timezone: string;

  @Column({ name: "retention_daily", type: "smallint", default: 7 })
  retentionDaily: number;

  @Column({ name: "retention_weekly", type: "smallint", default: 4 })
  retentionWeekly: number;

  @Column({ name: "retention_monthly", type: "smallint", default: 6 })
  retentionMonthly: number;

  @Column({ name: "last_backup_at", type: "timestamp", nullable: true })
  lastBackupAt: Date | null;

  @Column({
    name: "last_backup_status",
    type: "varchar",
    length: 20,
    nullable: true,
  })
  lastBackupStatus: string | null;

  @Column({
    name: "last_backup_error",
    type: "varchar",
    length: 1024,
    nullable: true,
  })
  lastBackupError: string | null;

  @Column({ name: "next_backup_at", type: "timestamp", nullable: true })
  nextBackupAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
