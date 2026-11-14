import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";

import { User } from "../../../users/entities/user.entity";

/**
 * One row per user whose MCP agent has ever polled.
 *
 * Progress, not business data: these three timestamps decide whether the chat's
 * tunnel indicator reads offline, listening or busy, and nothing financial
 * reads them. That is why R4 writes them through
 * `runOutsideActiveScopedManager` -- a poll's liveness must survive the
 * rollback of whatever request happened to observe it.
 */
@Entity("ai_relay_agents")
export class AiRelayAgent {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "timestamptz", name: "last_poll_at", nullable: true })
  lastPollAt: Date | null;

  /** When the current no-prompt streak began. Set on the first empty poll, cleared by any prompt. */
  @Column({ type: "timestamptz", name: "idle_since", nullable: true })
  idleSince: Date | null;

  /** When the agent was last told to stop for inactivity. The chat shows the notice until it polls again. */
  @Column({
    type: "timestamptz",
    name: "idle_disconnected_at",
    nullable: true,
  })
  idleDisconnectedAt: Date | null;

  /**
   * The one credential serving this user's web chat. Another credential's
   * poll claims nothing until this one has been quiet past `agentSeenAt` and
   * has no turn in flight.
   */
  @Column({ type: "text", name: "agent_credential", nullable: true })
  agentCredential: string | null;

  /** When the serving credential last asked for work. */
  @Column({ type: "timestamptz", name: "agent_seen_at", nullable: true })
  agentSeenAt: Date | null;
}
