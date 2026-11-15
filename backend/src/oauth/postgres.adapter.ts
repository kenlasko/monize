import { Logger } from "@nestjs/common";
import type { Adapter, AdapterPayload } from "oidc-provider";
import { DataSource } from "typeorm";
import { OAuthPayload } from "./entities/oauth-payload.entity";

const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

/**
 * How long a dynamically registered client lives without being used.
 *
 * oidc-provider stores a DCR client with no TTL, so before #2177 every
 * `POST /oauth/reg` left a row nothing ever removed. A client now expires this
 * long after registration, and every artifact minted for it after a person
 * consented (`CLIENT_ACTIVITY_MODELS`) pushes that back to this long from now.
 * It is longer than the refresh-token TTL in `OAuthProviderService`, so a client
 * never expires while a token minted for it can still be used; an idle client
 * past it gets `invalid_client` and registers again.
 */
export const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Saves that prove a client is in use: a Grant is written when a person
 * consents, a RefreshToken when the client refreshes. Every token is bound to a
 * Grant that lives shorter than a client, so these two are enough to keep a
 * client alive while anything minted for it can still be used, without a write
 * on every access token.
 */
const CLIENT_ACTIVITY_MODELS = new Set(["Grant", "RefreshToken"]);

/**
 * A client's expiry is slid forward only once it has fallen this far short of
 * a full TTL, so a client rewrites its row at most once a day rather than on
 * every token it is issued.
 */
const CLIENT_EXTEND_SLACK_MS = 24 * 60 * 60 * 1000;

/** Rows one sweep statement touches, so none holds a long lock. */
export const OAUTH_SWEEP_BATCH = 5000;

/** Statements per run; a larger backlog is taken by the next day's run. */
export const OAUTH_SWEEP_MAX_BATCHES = 200;

const logger = new Logger("PostgresAdapter");

/**
 * `oidc-provider`'s storage adapter, and the one place in the application that
 * reaches a table through a bare `DataSource` rather than `withScopedDb`.
 *
 * This is deliberate, and narrowly bounded. `node-oidc-provider` is mounted as
 * raw Express middleware in `main.ts`, outside Nest's request pipeline, so
 * these calls have **no ambient identity context at all** -- not a request
 * scope, and not `withSystemContext` either. Their safety does not come from
 * identity GUCs. It comes from `oauth_payloads` being RLS-exempt with no owner
 * column, addressed only by opaque provider identifiers, and from the runtime
 * role's grants on it being confined to the DML below.
 *
 * This is not precedent for any user-owned table: everything else goes through
 * `withScopedDb` (`src/common/db/scoped-db.ts`). The full boundary -- rejected
 * alternatives, consequences, and the triggers that would invalidate the
 * exception -- is `docs/row-level-security-contract.md`, and
 * `src/oauth/oauth-payload-access.spec.ts` plus the `OAUTH_PAYLOAD_ALLOWLIST`
 * ban in `eslint.config.mjs` fail when a new production reader appears.
 */
export class PostgresAdapter implements Adapter {
  constructor(
    private readonly model: string,
    private readonly dataSource: DataSource,
  ) {}

  private get repo() {
    return this.dataSource.getRepository(OAuthPayload);
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<void> {
    const ttlSeconds =
      this.model === "Client" ? OAUTH_CLIENT_IDLE_TTL_SECONDS : expiresIn;
    const expiresAt =
      ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;

    await this.repo.upsert(
      {
        id,
        model: this.model,
        payload: payload as unknown as Record<string, unknown>,
        grantId: GRANTABLE_MODELS.has(this.model)
          ? (payload.grantId ?? null)
          : null,
        userCode:
          this.model === "DeviceCode" ? (payload.userCode ?? null) : null,
        uid: this.model === "Session" ? (payload.uid ?? null) : null,
        expiresAt,
        consumedAt: null,
      } as OAuthPayload,
      { conflictPaths: ["id", "model"] },
    );

    if (
      CLIENT_ACTIVITY_MODELS.has(this.model) &&
      typeof payload.clientId === "string"
    ) {
      await this.extendClient(payload.clientId);
    }
  }

  /**
   * Slide a live client's expiry forward. An already-expired client is left
   * alone: `find` treats it as gone, so reviving it here would disagree with
   * what the provider was just told. A client with no expiry yet is left for
   * the sweep to adopt (`NULL > now` is not true).
   *
   * Best effort: the artifact this follows is already stored, and failing the
   * provider's save over bookkeeping would refuse a token grant that succeeded.
   * A missed slide costs at most a day of the client's 30.
   */
  private async extendClient(clientId: string): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000,
    );
    const staleBefore = new Date(expiresAt.getTime() - CLIENT_EXTEND_SLACK_MS);
    try {
      await this.repo
        .createQueryBuilder()
        .update()
        .set({ expiresAt })
        .where(
          "id = :clientId AND model = 'Client' AND expires_at > :now AND expires_at < :staleBefore",
          { clientId, now, staleBefore },
        )
        .execute();
    } catch (error) {
      logger.warn(
        `Could not extend OIDC client expiry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({ where: { id, model: this.model } });
    return this.toPayload(row);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({
      where: { userCode, model: this.model },
    });
    return this.toPayload(row);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({ where: { uid, model: this.model } });
    return this.toPayload(row);
  }

  async consume(id: string): Promise<void> {
    await this.repo.update(
      { id, model: this.model },
      { consumedAt: new Date() },
    );
  }

  async destroy(id: string): Promise<void> {
    await this.repo.delete({ id, model: this.model });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.repo.delete({ grantId });
  }

  private toPayload(row: OAuthPayload | null): AdapterPayload | undefined {
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    const result = { ...row.payload } as AdapterPayload;
    if (row.consumedAt) {
      (result as { consumed?: number }).consumed = Math.floor(
        row.consumedAt.getTime() / 1000,
      );
    }
    return result;
  }
}

/**
 * The daily sweep behind `OAuthProviderService.sweepExpiredPayloads` (#2177).
 *
 * First it gives every client stored with no expiry (all of them, before
 * #2177) the idle TTL from now, so the clients a flood already left expire like
 * new ones and a client still in use is slid forward by its next token. Then it
 * deletes every row past its expiry; `find` already treats those as absent, so
 * deleting them late is safe and nothing reads them in between.
 *
 * Each statement is bounded and its own transaction; `FOR UPDATE SKIP LOCKED`
 * lets replicas firing together take disjoint rows, and the later ones find
 * nothing. The clock is this process's, not `CURRENT_TIMESTAMP`, because
 * `expires_at` is a `TIMESTAMP` without zone that `upsert` writes and
 * `toPayload` reads against this process's clock; the database's zoned clock
 * would depend on the session time zone. Replica clock skew moves a deletion by
 * that skew, which matters to nothing that expires in minutes or more.
 */
export async function sweepOAuthPayloads(
  dataSource: DataSource,
): Promise<{ adopted: number; deleted: number }> {
  const repo = dataSource.getRepository(OAuthPayload);
  const expiresAt = new Date(Date.now() + OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000);
  // Batched in primary-key order from where the last batch stopped: no index
  // covers a NULL expires_at, so a batch restarting from the top would rescan
  // the rows already adopted, and one statement over a flooded table would
  // hold every row lock at once. After the first run nothing matches.
  let adopted = 0;
  let after = "";
  for (let i = 0; i < OAUTH_SWEEP_MAX_BATCHES; i += 1) {
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ expiresAt })
      .where(
        `(id, model) IN (SELECT id, model FROM oauth_payloads
                          WHERE model = 'Client' AND expires_at IS NULL AND id > :after
                          ORDER BY id LIMIT :batch FOR UPDATE SKIP LOCKED)`,
        { after, batch: OAUTH_SWEEP_BATCH },
      )
      .returning(["id"])
      .execute();
    const ids = (result.raw as Array<{ id: string }>).map((row) => row.id);
    adopted += ids.length;
    if (ids.length < OAUTH_SWEEP_BATCH) break;
    after = ids.reduce((max, id) => (id > max ? id : max), after);
  }

  const now = new Date();
  let deleted = 0;
  for (let i = 0; i < OAUTH_SWEEP_MAX_BATCHES; i += 1) {
    const result = await repo
      .createQueryBuilder()
      .delete()
      .where(
        `(id, model) IN (SELECT id, model FROM oauth_payloads
                          WHERE expires_at < :now
                          LIMIT :batch FOR UPDATE SKIP LOCKED)`,
        { now, batch: OAUTH_SWEEP_BATCH },
      )
      .execute();
    const affected = result.affected ?? 0;
    deleted += affected;
    if (affected < OAUTH_SWEEP_BATCH) break;
  }
  return { adopted, deleted };
}

export function makeAdapterFactory(dataSource: DataSource) {
  return (model: string) => new PostgresAdapter(model, dataSource);
}
