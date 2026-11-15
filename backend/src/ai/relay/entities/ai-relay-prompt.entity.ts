import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";

import { User } from "../../../users/entities/user.entity";

import { RelayAttachmentRef } from "../ai-relay.types";

/** The turn as the agent receives it. Handed over whole; never filtered on in SQL. */
export interface RelayPromptPayload {
  prompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: RelayAttachmentRef[];
}

/** The agent's answer. */
export interface RelayAnswerPayload {
  text: string;
}

/**
 * `pending` -> `claimed` -> `answered` -> `expired`, and `expired` directly
 * from either of the first two.
 *
 * `expired` is the one terminal state and it carries both endings: a turn
 * nobody finished, and one whose answer the browser has taken. They are not
 * told apart because nothing needs to -- the row is dead to every reader either
 * way, and the sweep deletes it on the same schedule. `answered_at` is what
 * distinguishes them for a human reading the table.
 *
 * Every transition is a conditional `UPDATE` whose `WHERE` names the status it
 * is leaving, so the loser of a race gets zero rows back and learns it lost
 * from the database rather than from a read it had already passed.
 */
export type RelayPromptStatus = "pending" | "claimed" | "answered" | "expired";

/**
 * One relayed chat turn.
 *
 * This replaces the `pending`, `inFlight` and `buffered` maps in
 * `ai-relay.service.ts`, which made two promises the relay could not keep: a
 * second replica serving the agent's poll cannot see a prompt the first replica
 * queued, and a restart between "enqueued" and "answered" loses the turn with
 * nothing able to notice.
 */
@Entity("ai_relay_prompts")
@Index("idx_ai_relay_prompts_claim", ["userId", "status", "createdAt"])
// Declared here as well as in schema.sql, under the same name: TypeORM builds
// the integration harness's database from this metadata, so a constraint only
// schema.sql carries is one the harness cannot observe -- and an integration
// spec that cannot observe it is not evidence about production.
@Check(
  "ck_ai_relay_prompts_status",
  "status IN ('pending', 'claimed', 'answered', 'expired')",
)
export class AiRelayPrompt {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  // Declared so the entity-derived schema the integration harness builds
  // carries the same ON DELETE CASCADE schema.sql does; a harness whose FK
  // rule differs is not evidence about production
  // (schema-entity-parity.integration.spec.ts).
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  /** Defaults to `pending` in both databases: that is the state a turn is born in. */
  @Column({ type: "text", default: "pending" })
  status: RelayPromptStatus;

  @Column({ type: "jsonb" })
  prompt: RelayPromptPayload;

  @Column({ type: "jsonb", nullable: true })
  answer: RelayAnswerPayload | null;

  /**
   * The MCP session that claimed this turn.
   *
   * A relay turn belongs to ONE session: liveness and tool activity from
   * another session the same user has open are not part of it and must not
   * steer it.
   */
  @Column({ type: "text", name: "claimed_by", nullable: true })
  claimedBy: string | null;

  /**
   * The credential that claimed this turn. Only it may answer the turn or
   * adopt it from a reconnected session: a session is a property of one
   * connection, the credential is what the user actually granted.
   */
  @Column({ type: "text", name: "claimed_credential", nullable: true })
  claimedCredential: string | null;

  @Column({
    type: "timestamptz",
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @Column({ type: "timestamptz", name: "claimed_at", nullable: true })
  claimedAt: Date | null;

  @Column({ type: "timestamptz", name: "answered_at", nullable: true })
  answeredAt: Date | null;

  /** The turn's own deadline. A row past it is claimable by nobody and sweepable by the cron. */
  @Index("idx_ai_relay_prompts_expiry")
  @Column({ type: "timestamptz", name: "expires_at" })
  expiresAt: Date;
}
