import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  AUTH_STATE_TTL_MS,
  BANK_SYNC_STORED_MESSAGE_MAX_LENGTH,
  MAX_CONSENT_VALIDITY_DAYS,
  SECONDS_PER_DAY,
} from "./bank-sync.constants";
import type {
  BankSyncNotifySuccessMode,
  BankSyncPsuType,
  BankSyncProviderName,
} from "./bank-sync.constants";
import { BANK_SYNC_DEFAULT_PROVIDER } from "./bank-sync.constants";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import {
  describeSyncFailure,
  storedFailureMessage,
  toBankSyncException,
} from "./bank-sync-errors";
import {
  toBankSyncAccountView,
  toBankSyncConnectionView,
} from "./bank-sync-views";
import { BankSyncMatchService } from "./bank-sync-match.service";
import type {
  BankInstitutionView,
  BankSyncAccountView,
  BankSyncAuthorizationStartView,
  BankSyncConnectionView,
  BankSyncMatchedConnectionView,
  BankSyncMatchResult,
} from "./bank-sync.types";
import type { BankSyncCallbackDto } from "./dto/bank-sync-callback.dto";
import type { CreateBankSyncConnectionDto } from "./dto/create-bank-sync-connection.dto";
import { COUNTRY_CODE_PATTERN } from "./dto/list-institutions-query.dto";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import { BankSyncProviderError } from "./providers/bank-sync-provider.errors";
import type {
  BankAccountDescriptor,
  BankInstitution,
  BankSyncCredentials,
  PsuContext,
  StartAuthorizationInput,
} from "./providers/bank-sync-provider.interface";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** 32 random bytes, base64url: the one-time state the callback carries back. */
export function newAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** What is stored of a state: its hash. The state itself is never persisted. */
export const hashAuthState = sha256Hex;

/**
 * The consent length asked for: the institution's maximum, capped at
 * `MAX_CONSENT_VALIDITY_DAYS`. A bank that states no (or a nonsensical)
 * maximum gets the cap (spec section 5).
 */
export function consentValiditySeconds(maximumSeconds: number | null): number {
  const cap = MAX_CONSENT_VALIDITY_DAYS * SECONDS_PER_DAY;
  return maximumSeconds !== null &&
    Number.isFinite(maximumSeconds) &&
    maximumSeconds > 0
    ? Math.min(maximumSeconds, cap)
    : cap;
}

/** A bank's stated maximum, in whole days for display; null when it stated none. */
function maximumValidityDays(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(seconds / SECONDS_PER_DAY));
}

/** A message cut to the width of the column it is stored in. */
const bounded = (text: string): string =>
  text.slice(0, BANK_SYNC_STORED_MESSAGE_MAX_LENGTH);

/**
 * A connection's life: authorizing at the bank, coming back, re-authorizing,
 * listing, disconnecting (docs/specs/bank-sync.md section 5).
 *
 * Three rules shape the class.
 *
 * **The state is single-use because claiming it clears it.** The callback's
 * conditional `UPDATE ... SET auth_state_hash = NULL ... RETURNING` is the
 * claim: it matches only this user's row whose state is unspent and
 * younger than `AUTH_STATE_TTL_MS`, so a replayed, expired or foreign state
 * finds nothing and gets the same 400. Two racing callbacks cannot both match.
 *
 * **A provider call is never made inside a transaction.** The row is committed
 * before `startAuthorization` and after `completeAuthorization` returns, so a
 * slow bank holds no connection and no lock.
 *
 * **A failure is recorded, not swallowed.** When a provider call fails the row
 * records a bounded message, and the caller still gets the mapped HTTP error.
 * Only a first-time (`pending`) connection becomes `failed`: a renewal that
 * fails leaves an `active` or `expired` connection as it was.
 */
@Injectable()
export class BankSyncConnectionsService {
  private readonly logger = new Logger(BankSyncConnectionsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly credentials: BankSyncCredentialsService,
    private readonly registry: BankSyncProviderRegistry,
    private readonly matcher: BankSyncMatchService,
  ) {}

  /** The banks the provider can connect to in one country. */
  async listInstitutions(
    userId: string,
    country: string,
  ): Promise<BankInstitutionView[]> {
    const code = this.requireCountry(country);
    const credentials = await this.credentials.resolveCredentials(
      userId,
      BANK_SYNC_DEFAULT_PROVIDER,
    );
    const institutions = await this.fetchInstitutions(
      BANK_SYNC_DEFAULT_PROVIDER,
      credentials,
      code,
    );
    return institutions.map((institution) => ({
      name: institution.name,
      country: institution.country,
      logoUrl: institution.logoUrl,
      psuTypes: institution.psuTypes,
      maximumConsentValidityDays: maximumValidityDays(
        institution.maximumConsentValiditySeconds,
      ),
    }));
  }

  /**
   * Begin authorizing at a bank: check the institution exists and allows the
   * kind of access, store the row with the state's hash, then (after the commit)
   * ask the provider for the URL to send the user to.
   */
  async start(
    userId: string,
    dto: CreateBankSyncConnectionDto,
  ): Promise<BankSyncAuthorizationStartView> {
    const provider = BANK_SYNC_DEFAULT_PROVIDER;
    const prepared = await this.prepareAuthorization(userId, provider, {
      institutionName: dto.institutionName,
      country: dto.country,
      psuType: dto.psuType,
    });
    const state = newAuthState();

    const connectionId = await withScopedDb(this.dataSource, async (m) => {
      const rows: { id: string }[] = await m.query(
        `INSERT INTO bank_sync_connections
           (user_id, provider, institution_name, institution_country, psu_type,
            status, auth_state_hash, auth_started_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, CURRENT_TIMESTAMP)
         RETURNING id`,
        [
          userId,
          provider,
          prepared.institution.name,
          prepared.institution.country.toUpperCase(),
          dto.psuType,
          hashAuthState(state),
        ],
      );
      return rows[0].id;
    });

    return this.dispatchAuthorization(userId, connectionId, provider, {
      credentials: prepared.credentials,
      input: {
        institutionName: prepared.institution.name,
        country: prepared.institution.country.toUpperCase(),
        redirectUrl: this.credentials.redirectUrl(),
        state,
        validUntil: prepared.validUntil,
        psuType: dto.psuType,
      },
    });
  }

  /**
   * A new authorization on the same row: a new state and its start time, and
   * nothing else. The status is left alone, so the session that works today
   * keeps syncing until the new one replaces it (a renewal the user abandons or
   * the bank refuses must not disable a working connection); the accounts and
   * their mappings are kept.
   */
  async reauthorize(
    userId: string,
    connectionId: string,
  ): Promise<BankSyncAuthorizationStartView> {
    const row = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(BankSyncConnection)
        .findOne({ where: { id: connectionId, userId } }),
    );
    if (!row) throw this.connectionNotFound(connectionId);

    const prepared = await this.prepareAuthorization(userId, row.provider, {
      institutionName: row.institutionName,
      country: row.institutionCountry,
      psuType: row.psuType,
    });
    const state = newAuthState();

    const updated = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `UPDATE bank_sync_connections
              SET auth_state_hash = $3,
                  auth_started_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
        RETURNING id`,
          [connectionId, userId, hashAuthState(state)],
        ),
      ),
    );
    if (updated.length === 0) throw this.connectionNotFound(connectionId);

    return this.dispatchAuthorization(userId, connectionId, row.provider, {
      credentials: prepared.credentials,
      input: {
        institutionName: prepared.institution.name,
        country: prepared.institution.country.toUpperCase(),
        redirectUrl: this.credentials.redirectUrl(),
        state,
        validUntil: prepared.validUntil,
        psuType: row.psuType,
      },
    });
  }

  /**
   * The bank's redirect came back. Claim the state, then either record the
   * bank's refusal or exchange the code for a session and activate the
   * connection. After the activation commits, every unlinked bank account whose
   * identifier names exactly one of the user's accounts is linked to it
   * (spec section 5a); the answer lists what was linked and what is ambiguous.
   */
  async completeCallback(
    userId: string,
    dto: BankSyncCallbackDto,
  ): Promise<BankSyncMatchedConnectionView> {
    const errorText = dto.error?.trim() ?? "";
    const code = dto.code?.trim() ?? "";
    // Refused before the claim: a callback that says nothing must not spend a
    // state the user can still use.
    if (errorText === "" && code === "") {
      throw new BadRequestException(
        tr(
          "errors.bankSync.callbackIncomplete",
          "The bank's answer carried neither an authorization code nor an error.",
        ),
      );
    }

    const claimed = await withScopedDb(this.dataSource, async (m) => {
      // No condition on `status`: a renewal runs on a connection that is
      // `active` (or `expired`), and a brand-new one is still `pending`. What
      // makes the claim this user's, single-use and fresh is the state itself.
      const rows = returnedRows<{
        id: string;
        provider: BankSyncProviderName;
      }>(
        await m.query(
          `UPDATE bank_sync_connections
              SET auth_state_hash = NULL
            WHERE user_id = $1
              AND auth_state_hash = $2
              AND auth_started_at > CURRENT_TIMESTAMP - ($3::text || ' milliseconds')::interval
        RETURNING id, provider`,
          [userId, hashAuthState(dto.state), String(AUTH_STATE_TTL_MS)],
        ),
      );
      const row = rows[0];
      if (!row) return null;
      // The bank's refusal is recorded in the claiming transaction: nothing else
      // about the row changes, and nothing has to be undone. Only a first-time
      // (`pending`) connection becomes `failed`; one that was `active` or
      // `expired` keeps its status, so a refused renewal never disables it.
      if (errorText !== "") {
        const description = dto.errorDescription?.trim() || errorText;
        await m.query(
          `UPDATE bank_sync_connections
              SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
                  last_error = $3
            WHERE id = $1 AND user_id = $2`,
          [row.id, userId, bounded(description)],
        );
        return { ...row, refused: true as const };
      }
      return { ...row, refused: false as const };
    });

    if (!claimed) {
      throw new BadRequestException(
        tr(
          "errors.bankSync.authStateInvalid",
          "This authorization link is invalid, has expired or was already used. Start the connection again.",
        ),
      );
    }
    if (claimed.refused) {
      return {
        connection: await this.getView(userId, claimed.id),
        linked: [],
        suggestions: [],
      };
    }

    const provider = this.registry.getByName(claimed.provider);
    let session: Awaited<ReturnType<typeof provider.completeAuthorization>>;
    try {
      const credentials = await this.credentials.resolveCredentials(
        userId,
        claimed.provider,
      );
      session = await provider.completeAuthorization(credentials, code);
      // A production application in restricted mode is answered with an empty
      // list for any account that was not linked to it. Keeping that session
      // would show a working connection with nothing to link, so it is ended
      // and the failure says what to do.
      if (session.accounts.length === 0) {
        await this.revokeBestEffort(
          userId,
          claimed.provider,
          session.sessionId,
        );
        throw new BankSyncProviderError(
          "no_accounts_linked",
          "The provider returned a session with no accounts.",
        );
      }
    } catch (error) {
      // The claim cleared the state, so this row is the one whose state is NULL.
      await this.markFailed(
        userId,
        claimed.id,
        storedFailureMessage(error),
        null,
      );
      throw toBankSyncException(error);
    }

    let activated: {
      view: BankSyncConnectionView;
      previousSessionId: string | null;
    };
    try {
      activated = await this.activate(userId, claimed.id, session.sessionId, {
        validUntil: session.validUntil,
        accounts: session.accounts,
      });
    } catch (error) {
      // The consent exists at the bank but Monize could not record it: ask the
      // bank to drop it rather than leave a session nobody can see.
      await this.revokeBestEffort(userId, claimed.provider, session.sessionId);
      await this.markFailed(
        userId,
        claimed.id,
        storedFailureMessage(error),
        null,
      );
      throw error;
    }

    // A renewal replaced the session: the previous one is asked to end now, after
    // the commit and outside any transaction. Best effort, like a disconnect.
    if (
      activated.previousSessionId !== null &&
      activated.previousSessionId !== session.sessionId
    ) {
      await this.revokeBestEffort(
        userId,
        claimed.provider,
        activated.previousSessionId,
      );
    }

    // The consent is recorded and committed: a matching failure must not undo it.
    const matched = await this.autoLink(userId, claimed.id);
    return {
      connection:
        matched.linked.length > 0
          ? await this.getView(userId, claimed.id)
          : activated.view,
      ...matched,
    };
  }

  /**
   * Match the connection's bank accounts to the user's accounts by number and
   * link the unambiguous ones (spec section 5a), for a connection made before
   * identifiers were stored: an unlinked bank account without one has its
   * details read from the provider first. `psu` is the person at the keyboard.
   */
  async matchAccounts(
    userId: string,
    connectionId: string,
    psu: PsuContext | null,
  ): Promise<BankSyncMatchedConnectionView> {
    const matched = await this.matcher.match(userId, connectionId, {
      fetchMissing: true,
      psu,
    });
    return {
      connection: await this.getView(userId, connectionId),
      ...matched,
    };
  }

  /** Every connection of the user with its bank accounts. */
  async list(userId: string): Promise<BankSyncConnectionView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const connections = await m.getRepository(BankSyncConnection).find({
        where: { userId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      if (connections.length === 0) return [];
      const accounts = await m.getRepository(BankSyncAccount).find({
        where: { userId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      return connections.map((connection) =>
        toBankSyncConnectionView(
          connection,
          accounts.filter((account) => account.connectionId === connection.id),
        ),
      );
    });
  }

  /**
   * Change the settings of a connection: whether the daily sync reads it and
   * when that sync reports a successful run. Only the fields present are
   * written (`COALESCE` over the stored value, one statement), and a patch with
   * none is refused.
   */
  async updateConnection(
    userId: string,
    connectionId: string,
    patch: {
      autoSync?: boolean;
      notifySuccess?: BankSyncNotifySuccessMode;
      tagOperationType?: boolean;
    },
  ): Promise<BankSyncConnectionView> {
    if (
      patch.autoSync === undefined &&
      patch.notifySuccess === undefined &&
      patch.tagOperationType === undefined
    ) {
      throw new BadRequestException(
        tr(
          "errors.bankSync.nothingToUpdate",
          "Send autoSync, notifySuccess or tagOperationType to change a bank connection.",
        ),
      );
    }
    const updated = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `UPDATE bank_sync_connections
              SET auto_sync = COALESCE($3, auto_sync),
                  notify_success = COALESCE($4, notify_success),
                  tag_operation_type = COALESCE($5, tag_operation_type)
            WHERE id = $1 AND user_id = $2
        RETURNING id`,
          [
            connectionId,
            userId,
            patch.autoSync ?? null,
            patch.notifySuccess ?? null,
            patch.tagOperationType ?? null,
          ],
        ),
      ),
    );
    if (updated.length === 0) throw this.connectionNotFound(connectionId);
    return this.getView(userId, connectionId);
  }

  /**
   * Ask the provider to end the session, then delete the row. A provider
   * failure is logged and does not block the local delete: the consent expires
   * at the bank by itself (spec section 5).
   */
  async disconnect(userId: string, connectionId: string): Promise<void> {
    const row = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(BankSyncConnection)
        .findOne({ where: { id: connectionId, userId } }),
    );
    if (!row) throw this.connectionNotFound(connectionId);

    if (row.externalSessionId) {
      await this.revokeBestEffort(userId, row.provider, row.externalSessionId);
    }

    await withScopedDb(this.dataSource, async (m) => {
      await m
        .getRepository(BankSyncConnection)
        .delete({ id: connectionId, userId });
    });
  }

  /** One connection with its bank accounts, or 404. */
  async getView(
    userId: string,
    connectionId: string,
  ): Promise<BankSyncConnectionView> {
    return withScopedDb(this.dataSource, async (m) => {
      const connection = await m
        .getRepository(BankSyncConnection)
        .findOne({ where: { id: connectionId, userId } });
      if (!connection) throw this.connectionNotFound(connectionId);
      const accounts = await m.getRepository(BankSyncAccount).find({
        where: { userId, connectionId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      return toBankSyncConnectionView(connection, accounts);
    });
  }

  /** The bank accounts of one connection, as views (used by callers that need only them). */
  async listAccounts(
    userId: string,
    connectionId: string,
  ): Promise<BankSyncAccountView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = await m.getRepository(BankSyncAccount).find({
        where: { userId, connectionId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      return rows.map(toBankSyncAccountView);
    });
  }

  // ---------------------------------------------------------------------------

  /** The automatic link after a callback; a failure is logged, never thrown. */
  private async autoLink(
    userId: string,
    connectionId: string,
  ): Promise<BankSyncMatchResult> {
    try {
      return await this.matcher.match(userId, connectionId, {
        fetchMissing: false,
        psu: null,
      });
    } catch (error) {
      this.logger.warn(
        `Matching the bank accounts of connection ${connectionId} to accounts failed: ${describeSyncFailure(error)}`,
      );
      return { linked: [], suggestions: [] };
    }
  }

  private requireCountry(country: string): string {
    const code =
      typeof country === "string" ? country.trim().toUpperCase() : "";
    if (!COUNTRY_CODE_PATTERN.test(code)) {
      throw new BadRequestException(
        tr(
          "errors.bankSync.countryInvalid",
          "The country must be an ISO 3166-1 alpha-2 code such as PL.",
        ),
      );
    }
    return code;
  }

  private connectionNotFound(connectionId: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.bankSync.connectionNotFound",
        `Bank connection with ID ${connectionId} not found`,
        { id: connectionId },
      ),
    );
  }

  private async fetchInstitutions(
    providerName: BankSyncProviderName,
    credentials: BankSyncCredentials,
    country: string,
  ): Promise<BankInstitution[]> {
    try {
      return await this.registry
        .getByName(providerName)
        .listInstitutions(credentials, country);
    } catch (error) {
      throw toBankSyncException(error);
    }
  }

  /**
   * Everything a new authorization needs from the provider, before any row is
   * written: the credentials, the institution (which must exist and allow the
   * kind of access) and the consent length. A failure here changes nothing.
   */
  private async prepareAuthorization(
    userId: string,
    providerName: BankSyncProviderName,
    wanted: {
      institutionName: string;
      country: string;
      psuType: BankSyncPsuType;
    },
  ): Promise<{
    credentials: BankSyncCredentials;
    institution: BankInstitution;
    validUntil: Date;
  }> {
    const country = this.requireCountry(wanted.country);
    const credentials = await this.credentials.resolveCredentials(
      userId,
      providerName,
    );
    const institutions = await this.fetchInstitutions(
      providerName,
      credentials,
      country,
    );
    const institution = institutions.find(
      (candidate) =>
        candidate.name === wanted.institutionName &&
        candidate.country.toUpperCase() === country,
    );
    if (!institution) {
      throw new BadRequestException(
        tr(
          "errors.bankSync.institutionNotFound",
          `The bank "${wanted.institutionName}" is not available in ${country}. Pick it from the list.`,
          { name: wanted.institutionName, country },
        ),
      );
    }
    // An institution that lists no access types states nothing to check against.
    // Compared case-insensitively: the provider's spelling is not ours.
    if (
      institution.psuTypes.length > 0 &&
      !institution.psuTypes.some(
        (type) => type.trim().toLowerCase() === wanted.psuType.toLowerCase(),
      )
    ) {
      throw new BadRequestException(
        tr(
          "errors.bankSync.psuTypeNotAllowed",
          `This bank does not offer ${wanted.psuType} access.`,
          { psuType: wanted.psuType },
        ),
      );
    }
    const seconds = consentValiditySeconds(
      institution.maximumConsentValiditySeconds,
    );
    return {
      credentials,
      institution,
      validUntil: new Date(Date.now() + seconds * 1000),
    };
  }

  /**
   * Ask the provider for the authorization URL, after the row is committed and
   * outside any transaction. A failure is recorded by `markFailed`.
   */
  private async dispatchAuthorization(
    userId: string,
    connectionId: string,
    providerName: BankSyncProviderName,
    call: { credentials: BankSyncCredentials; input: StartAuthorizationInput },
  ): Promise<BankSyncAuthorizationStartView> {
    try {
      const { url } = await this.registry
        .getByName(providerName)
        .startAuthorization(call.credentials, call.input);
      return { connectionId, authorizationUrl: url };
    } catch (error) {
      await this.markFailed(
        userId,
        connectionId,
        storedFailureMessage(error),
        hashAuthState(call.input.state),
      );
      throw toBankSyncException(error);
    }
  }

  /**
   * Record a failed authorization and clear its state, so a failed attempt
   * cannot be claimed later. Only a first-time (`pending`) connection becomes
   * `failed`; one that was `active`, `expired` or already `failed` keeps its
   * status and records `last_error` alone, so a failed renewal never disables a
   * working session. `stateHash` is the state the failed attempt held (`null`
   * once a callback has claimed it): a newer authorization started meanwhile
   * holds a different one, so the predicate leaves it alone. Never throws: it
   * runs on the way out of a failure and must not replace it.
   */
  private async markFailed(
    userId: string,
    connectionId: string,
    message: string,
    stateHash: string | null,
  ): Promise<void> {
    try {
      await withScopedDb(this.dataSource, async (m) => {
        await m.query(
          `UPDATE bank_sync_connections
              SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
                  last_error = $3,
                  auth_state_hash = NULL
            WHERE id = $1 AND user_id = $2
              AND auth_state_hash IS NOT DISTINCT FROM $4::varchar`,
          [connectionId, userId, bounded(message), stateHash],
        );
      });
    } catch (error) {
      this.logger.error(
        `Could not record the failed authorization of connection ${connectionId}: ${describeSyncFailure(error)}`,
      );
    }
  }

  /**
   * The second transaction of a callback: the session exists, so the row becomes
   * `active` and the session's accounts are upserted. A bank account is matched
   * to an existing row of this connection by `identification_hash` first (stable
   * across sessions, so every mapping and cut-off survives a re-authorization),
   * then by the provider's account id; anything else is added unmapped.
   */
  private async activate(
    userId: string,
    connectionId: string,
    sessionId: string,
    session: { validUntil: Date | null; accounts: BankAccountDescriptor[] },
  ): Promise<{
    view: BankSyncConnectionView;
    /** The session this one replaces, for the caller to revoke after the commit. */
    previousSessionId: string | null;
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const connections = m.getRepository(BankSyncConnection);
      const connection = await connections.findOne({
        where: { id: connectionId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!connection) throw this.connectionNotFound(connectionId);
      // Still the authorization this callback claimed? A re-authorization
      // started meanwhile holds a new state and owns the row now, and this
      // session is not its.
      if (connection.authStateHash !== null) {
        throw new ConflictException(
          tr(
            "errors.bankSync.authorizationSuperseded",
            "A newer authorization was started for this connection. Use the newest link.",
          ),
        );
      }

      const previousSessionId = connection.externalSessionId;
      connection.status = "active";
      connection.externalSessionId = sessionId;
      connection.validUntil = session.validUntil;
      connection.lastError = null;
      await connections.save(connection);

      const existing = await m.getRepository(BankSyncAccount).find({
        where: { userId, connectionId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      await this.upsertAccounts(m, userId, connectionId, existing, session);

      const accounts = await m.getRepository(BankSyncAccount).find({
        where: { userId, connectionId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      return {
        view: toBankSyncConnectionView(connection, accounts),
        previousSessionId,
      };
    });
  }

  private async upsertAccounts(
    m: EntityManager,
    userId: string,
    connectionId: string,
    existing: readonly BankSyncAccount[],
    session: { accounts: BankAccountDescriptor[] },
  ): Promise<void> {
    const repo = m.getRepository(BankSyncAccount);
    const claimed = new Set<string>();
    const seenExternal = new Set<string>();

    for (const descriptor of session.accounts) {
      // A provider that lists one account twice must not insert it twice.
      if (seenExternal.has(descriptor.externalAccountId)) continue;
      seenExternal.add(descriptor.externalAccountId);

      const match =
        existing.find(
          (row) =>
            !claimed.has(row.id) &&
            descriptor.identificationHash !== null &&
            row.identificationHash === descriptor.identificationHash,
        ) ??
        existing.find(
          (row) =>
            !claimed.has(row.id) &&
            row.externalAccountId === descriptor.externalAccountId,
        );

      if (match) {
        claimed.add(match.id);
        match.externalAccountId = descriptor.externalAccountId;
        match.identificationHash =
          descriptor.identificationHash ?? match.identificationHash;
        match.displayName = descriptor.displayName ?? match.displayName;
        match.identifierMasked =
          descriptor.identifierMasked ?? match.identifierMasked;
        match.accountIdentifier =
          descriptor.accountIdentifier ?? match.accountIdentifier;
        match.cashAccountType =
          descriptor.cashAccountType ?? match.cashAccountType;
        match.currencyCode = descriptor.currencyCode ?? match.currencyCode;
        await repo.save(match);
        continue;
      }

      await repo.save(
        repo.create({
          userId,
          connectionId,
          externalAccountId: descriptor.externalAccountId,
          identificationHash: descriptor.identificationHash,
          displayName: descriptor.displayName,
          identifierMasked: descriptor.identifierMasked,
          accountIdentifier: descriptor.accountIdentifier,
          cashAccountType: descriptor.cashAccountType,
          currencyCode: descriptor.currencyCode,
          accountId: null,
          syncFromDate: null,
        }),
      );
    }
  }

  /** Ask the provider to end a session; a failure is logged, never thrown. */
  private async revokeBestEffort(
    userId: string,
    providerName: BankSyncProviderName,
    sessionId: string,
  ): Promise<void> {
    try {
      const credentials = await this.credentials.resolveCredentials(
        userId,
        providerName,
      );
      await this.registry
        .getByName(providerName)
        .revokeSession(credentials, sessionId);
    } catch (error) {
      this.logger.warn(
        `The provider session of a bank connection could not be revoked; the consent will lapse at the bank on its own: ${describeSyncFailure(error)}`,
      );
    }
  }
}
