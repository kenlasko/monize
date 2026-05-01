import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("oauth_payloads")
@Index(["grantId"])
@Index(["uid"])
@Index(["userCode"])
export class OAuthPayload {
  @PrimaryColumn({ type: "varchar", length: 255 })
  id: string;

  @PrimaryColumn({ type: "varchar", length: 50 })
  model: string;

  @Column({ type: "jsonb" })
  payload: Record<string, any>;

  @Column({ name: "grant_id", type: "varchar", length: 255, nullable: true })
  grantId: string | null;

  @Column({ name: "user_code", type: "varchar", length: 255, nullable: true })
  userCode: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  uid: string | null;

  @Column({ name: "expires_at", type: "timestamp", nullable: true })
  expiresAt: Date | null;

  @Column({ name: "consumed_at", type: "timestamp", nullable: true })
  consumedAt: Date | null;
}
