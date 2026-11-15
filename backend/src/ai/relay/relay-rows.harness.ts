import {
  RelayAnswerPayload,
  RelayPromptPayload,
  RelayPromptStatus,
} from "./entities/ai-relay-prompt.entity";
import { RelayAttachmentKind } from "./entities/ai-relay-attachment.entity";
import { RelayAttachmentStore } from "./relay-attachment.store";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

/**
 * The three `ai_relay_*` tables, answering `AiRelayService`'s statements.
 *
 * A double that only recorded the SQL would make every behavioural assertion in
 * the relay's spec vacuous: FIFO order, one-claim-wins, a refused second answer,
 * the idle window being pushed out by liveness and clamped by the hard deadline
 * are all properties of *what the statement does to the row*, not of the string.
 * So this evaluates them, on the same rules the real table does -- conditional
 * on `status`, compared against a single clock, `LEAST`-clamped.
 *
 * Two things it deliberately does not model, because no in-process double can,
 * both proved by `test/integration/ai-relay-claim.integration.spec.ts` against
 * real connections (VER-001):
 *
 * - `FOR UPDATE SKIP LOCKED` under real concurrency.
 * - **Rollback.** `dataSource.transaction` here runs the callback and keeps
 *   whatever it wrote, so a spec about a failed transaction leaving no trace
 *   cannot be written against this. What a spec *can* assert here is that two
 *   statements were grouped into one transaction, from
 *   `dataSource.transaction.mock.calls`.
 *
 * It also cannot see a change to a statement's own semantics: the branches
 * below are matched on a fragment of the SQL and then re-implement the rule in
 * TypeScript, so dropping a `WHERE` clause or an `ORDER BY` leaves this green.
 * Every such rule therefore has an integration test as well.
 */
export interface RelayPromptRow {
  id: string;
  userId: string;
  status: RelayPromptStatus;
  prompt: RelayPromptPayload;
  answer: RelayAnswerPayload | null;
  claimedBy: string | null;
  /** The credential that claimed the turn; null until claimed. `=` never matches null. */
  claimedCredential: string | null;
  /** Epoch ms, all four, read through the harness's one clock. */
  createdAt: number;
  claimedAt: number | null;
  answeredAt: number | null;
  expiresAt: number;
}

/** One `ai_relay_agents` row: the liveness of a user's polling agent. */
export interface RelayAgentRow {
  userId: string;
  lastPollAt: number | null;
  idleSince: number | null;
  idleDisconnectedAt: number | null;
  /** The credential holding the user's chat, and when it last asked for work. */
  agentCredential: string | null;
  agentSeenAt: number | null;
}

/** One `ai_relay_actions` row: a card whose browser stream had already gone. */
export interface RelayActionRow {
  userId: string;
  id: string;
  card: unknown;
  createdAt: number;
  expiresAt: number;
}

/** One `ai_relay_attachments` row: a file uploaded with a prompt. */
export interface RelayAttachmentRow {
  id: string;
  userId: string;
  filename: string;
  kind: RelayAttachmentKind;
  mime: string;
  size: number;
  expiresAt: number;
  /** The cascading blob row, kept here because the cascade is what reclaims it. */
  data: Buffer;
}

export interface RelayRowsHarness {
  /** The mock DataSource to hand `AiRelayService`. */
  dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  /** The prompts, in insertion order. Assert on it; mutate it to set a scenario up. */
  rows: RelayPromptRow[];
  /** The agent liveness rows, at most one per user. */
  agents: RelayAgentRow[];
  /** The buffered confirmation cards, in insertion order. */
  actions: RelayActionRow[];
  /** The attachment rows, in insertion order, bytes and all. */
  attachments: RelayAttachmentRow[];
  /** A store over the same rows, ready to hand to `AiRelayService`. */
  attachmentStore: RelayAttachmentStore;
  /** Every statement the service issued, for the rare assertion about SQL itself. */
  statements: string[];
  /**
   * The same statements grouped by the transaction that carried them. Rollback
   * is not modelled, so this is how a spec asserts that two statements were at
   * least handed to one transaction.
   */
  transactions: string[][];
}

/** `CURRENT_TIMESTAMP`, which under a spec's fake timers is the spec's clock. */
function now(): number {
  return Date.now();
}

/**
 * Build the harness. `manager.query` is replaced with an interpreter over the
 * statements `AiRelayService` issues; anything else throws, so a new statement
 * announces itself instead of silently returning no rows.
 */
export function createRelayRowsHarness(): RelayRowsHarness {
  const scoped = createScopedDbMocks();
  const rows: RelayPromptRow[] = [];
  const agents: RelayAgentRow[] = [];
  const actions: RelayActionRow[] = [];
  const attachments: RelayAttachmentRow[] = [];
  const statements: string[] = [];
  const transactions: string[][] = [];
  let current: string[] | undefined;
  let sequence = 0;

  // Group each callback's statements, so "these two went together" is a claim a
  // spec can make even though this double cannot roll anything back.
  const runTransaction = scoped.dataSource.transaction.getMockImplementation()!;
  scoped.dataSource.transaction.mockImplementation(
    async (...args: unknown[]) => {
      const previous = current;
      current = [];
      transactions.push(current);
      try {
        return await (runTransaction as (...a: unknown[]) => unknown)(...args);
      } finally {
        current = previous;
      }
    },
  );

  const agentOf = (userId: string): RelayAgentRow => {
    const existing = agents.find((a) => a.userId === userId);
    if (existing) return existing;
    const created: RelayAgentRow = {
      userId,
      lastPollAt: null,
      idleSince: null,
      idleDisconnectedAt: null,
      agentCredential: null,
      agentSeenAt: null,
    };
    agents.push(created);
    return created;
  };

  const byId = (id: string, userId: string): RelayPromptRow | undefined =>
    rows.find((r) => r.id === id && r.userId === userId);

  scoped.manager.query.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      current?.push(sql);

      if (sql.includes("INSERT INTO ai_relay_attachments\n")) {
        const [id, userId, filename, kind, mime, size, ttlMs] = params as [
          string,
          string,
          string,
          RelayAttachmentKind,
          string,
          number,
          number,
        ];
        attachments.push({
          id,
          userId,
          filename,
          kind,
          mime,
          size,
          expiresAt: now() + ttlMs,
          // Filled by the blob INSERT below, exactly as the cascade pairs them.
          data: Buffer.alloc(0),
        });
        return [];
      }

      if (sql.includes("INSERT INTO ai_relay_attachment_blobs")) {
        const [id, data] = params as [string, Buffer];
        const row = attachments.find((a) => a.id === id);
        if (!row) throw new Error(`blob for unknown attachment ${id}`);
        row.data = data;
        return [];
      }

      if (sql.includes("FROM ai_relay_attachments a")) {
        const [id, userId] = params as [string, string];
        const row = attachments.find(
          (a) => a.id === id && a.userId === userId && a.expiresAt > now(),
        );
        return row
          ? [
              {
                id: row.id,
                filename: row.filename,
                kind: row.kind,
                mime: row.mime,
                data: row.data,
              },
            ]
          : [];
      }

      if (sql.includes("DELETE FROM ai_relay_attachments")) {
        const taken = sql.includes("expires_at <= CURRENT_TIMESTAMP")
          ? attachments.filter((a) => a.expiresAt <= now())
          : attachments.filter(
              (a) =>
                a.userId === (params[0] as string) &&
                (params[1] as string[]).includes(a.id),
            );
        for (const row of taken) {
          attachments.splice(attachments.indexOf(row), 1);
        }
        // The blob rows go with them: that is what the cascade does.
        return [[], taken.length];
      }

      // holdChat: must precede the generic agents branch below.
      if (
        sql.includes(
          "INSERT INTO ai_relay_agents (user_id, agent_credential, agent_seen_at)",
        )
      ) {
        const [userId, credentialId, windowMs] = params as [
          string,
          string,
          number,
        ];
        const existed = agents.some((a) => a.userId === userId);
        const agent = agentOf(userId);
        const holder = agent.agentCredential;
        const holderBusy = rows.some(
          (r) =>
            r.userId === userId &&
            r.claimedCredential === holder &&
            holder !== null &&
            ((r.status === "claimed" && r.expiresAt > now()) ||
              (r.answeredAt !== null && r.answeredAt + windowMs > now())),
        );
        const mayHold =
          !existed ||
          holder === null ||
          holder === credentialId ||
          ((agent.agentSeenAt ?? 0) + windowMs <= now() && !holderBusy);
        if (!mayHold) return [];
        agent.agentCredential = credentialId;
        agent.agentSeenAt = now();
        return [{ user_id: userId }];
      }

      if (sql.includes("INSERT INTO ai_relay_agents")) {
        const [userId, inactivityMs] = params as [string, number | undefined];
        const agent = agentOf(userId);
        if (sql.includes("last_poll_at = CURRENT_TIMESTAMP")) {
          agent.lastPollAt = now();
          agent.idleDisconnectedAt = null;
          return [];
        }
        if (sql.includes("idle_since = NULL")) {
          agent.idleSince = null;
          agent.idleDisconnectedAt = null;
          return [];
        }
        // shouldStopForIdle: start the clock, or end it and record the stop.
        if (agent.idleSince === null) {
          agent.idleSince = now();
        } else if (agent.idleSince + (inactivityMs ?? 0) <= now()) {
          agent.idleSince = null;
          agent.idleDisconnectedAt = now();
        }
        return [{ stop: agent.idleDisconnectedAt !== null }];
      }

      if (sql.includes("INSERT INTO ai_relay_actions")) {
        const [userId, id, cardJson, ttlMs] = params as [
          string,
          string,
          string,
          number,
        ];
        if (actions.some((a) => a.userId === userId && a.id === id)) {
          return [];
        }
        actions.push({
          userId,
          id,
          card: JSON.parse(cardJson),
          createdAt: now(),
          expiresAt: now() + ttlMs,
        });
        return [];
      }

      if (sql.includes("DELETE FROM ai_relay_actions")) {
        const [userId] = params as [string];
        const mine = actions.filter((a) => a.userId === userId);
        for (const row of mine) {
          actions.splice(actions.indexOf(row), 1);
        }
        return mine
          .filter((a) => a.expiresAt > now())
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((a) => ({ card: a.card }));
      }

      if (sql.includes("INSERT INTO ai_relay_prompts")) {
        const [userId, payload, queueWaitMs] = params as [
          string,
          string,
          number,
        ];
        const row: RelayPromptRow = {
          id: `prompt-${++sequence}`,
          userId,
          status: "pending",
          prompt: JSON.parse(payload) as RelayPromptPayload,
          answer: null,
          claimedBy: null,
          claimedCredential: null,
          createdAt: now(),
          claimedAt: null,
          answeredAt: null,
          expiresAt: now() + queueWaitMs,
        };
        rows.push(row);
        return [{ id: row.id }];
      }

      if (sql.includes("WITH next AS")) {
        const [userId, sessionId, idleMs, credentialId] = params as [
          string,
          string | null,
          number,
          string,
        ];
        const next = rows.find(
          (r) =>
            r.userId === userId &&
            r.status === "pending" &&
            r.expiresAt > now(),
        );
        if (!next) return [];
        next.status = "claimed";
        next.claimedAt = now();
        next.claimedBy = sessionId;
        next.claimedCredential = credentialId;
        next.expiresAt = now() + idleMs;
        return [{ id: next.id, prompt: next.prompt }];
      }

      if (sql.includes("SET status = 'answered'")) {
        const [promptId, userId, answer, bufferMs, credentialId] = params as [
          string,
          string,
          string,
          number,
          string,
        ];
        const row = byId(promptId, userId);
        if (
          !row ||
          row.status !== "claimed" ||
          row.claimedCredential !== credentialId ||
          row.expiresAt + bufferMs <= now()
        ) {
          return [];
        }
        row.status = "answered";
        row.answer = JSON.parse(answer) as RelayAnswerPayload;
        row.answeredAt = now();
        return [{ id: row.id }];
      }

      if (sql.includes("SET status = 'expired'")) {
        const [promptId, userId] = params as [string, string];
        const row = byId(promptId, userId);
        if (!row || row.status !== "answered") return [];
        row.status = "expired";
        return [{ answer: row.answer }];
      }

      if (sql.includes("SET claimed_by = COALESCE")) {
        const [promptId, userId, sessionId, idleMs, hardMs, credentialId] =
          params as [string, string, string | null, number, number, string];
        const row = byId(promptId, userId);
        if (
          !row ||
          row.status !== "claimed" ||
          row.claimedCredential !== credentialId ||
          row.expiresAt <= now()
        ) {
          return [];
        }
        row.claimedBy = sessionId ?? row.claimedBy;
        row.expiresAt = Math.min(now() + idleMs, (row.claimedAt ?? 0) + hardMs);
        return [{ id: row.id }];
      }

      if (sql.includes("SET expires_at = LEAST")) {
        const [userId, sessionId, idleMs, hardMs] = params as [
          string,
          string | null,
          number,
          number,
        ];
        const matches = rows.filter(
          (r) =>
            r.userId === userId &&
            r.status === "claimed" &&
            r.claimedBy === sessionId &&
            r.expiresAt > now(),
        );
        for (const row of matches) {
          row.expiresAt = Math.min(
            now() + idleMs,
            (row.claimedAt ?? 0) + hardMs,
          );
        }
        // `claimed_at` too: the caller picks the newest of several claimed
        // turns from it, and a double that withheld it would make that choice
        // untestable.
        return matches.map((r) => ({
          id: r.id,
          claimed_at: new Date(r.claimedAt ?? 0),
        }));
      }

      if (sql.includes("COUNT(*) FILTER")) {
        const [userId, connectedWindowMs] = params as [string, number];
        const live = rows.filter(
          (r) => r.userId === userId && r.expiresAt > now(),
        );
        const agent = agents.find((a) => a.userId === userId);
        return [
          {
            queued: String(live.filter((r) => r.status === "pending").length),
            in_flight: String(
              live.filter((r) => r.status === "claimed").length,
            ),
            connected:
              agent?.lastPollAt !== null &&
              agent?.lastPollAt !== undefined &&
              agent.lastPollAt > now() - connectedWindowMs,
            idle_disconnected: (agent?.idleDisconnectedAt ?? null) !== null,
          },
        ];
      }

      if (sql.includes("SELECT status, answer, prompt, claimed_at")) {
        const [promptId, userId] = params as [string, string];
        const row = byId(promptId, userId);
        if (!row) return [];
        return [
          {
            status: row.status,
            answer: row.answer,
            prompt: row.prompt,
            claimed_at: row.claimedAt === null ? null : new Date(row.claimedAt),
            expired: row.expiresAt <= now(),
            remaining_ms: String(Math.ceil(row.expiresAt - now())),
          },
        ];
      }

      if (sql.includes("SELECT id")) {
        const [userId, sessionId, bufferMs] = params as [
          string,
          string | null,
          number,
        ];
        const match = [...rows]
          .reverse()
          .find(
            (r) =>
              r.userId === userId &&
              r.status === "claimed" &&
              r.claimedBy === sessionId &&
              r.expiresAt + bufferMs > now(),
          );
        return match ? [{ id: match.id }] : [];
      }

      throw new Error(`createRelayRowsHarness: no rule for statement:\n${sql}`);
    },
  );

  return {
    dataSource: scoped.dataSource,
    rows,
    agents,
    actions,
    attachments,
    attachmentStore: new RelayAttachmentStore(scoped.dataSource as never),
    statements,
    transactions,
  };
}
