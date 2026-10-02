import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  describeFetchFailure,
  isTransportFailure,
} from "../../../common/http/fetch-failure.util";
import { isProviderUnavailable } from "../../../provider-health/provider-unavailable.error";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";
import {
  BankSyncProviderError,
  type BankSyncProviderErrorKind,
} from "../bank-sync-provider.errors";
import type {
  BankAccountDescriptor,
  BankBalance,
  BankInstitution,
  BankSyncCredentials,
  BankSyncProvider,
  BankTransaction,
  PsuContext,
  StartAuthorizationInput,
} from "../bank-sync-provider.interface";
import { signEnableBankingJwt } from "./enable-banking-jwt";
import { rawLogLines } from "./enable-banking-raw-log";
import {
  mapAccountDetails,
  mapApplication,
  mapAuthorizationUrl,
  mapBalance,
  mapInstitutions,
  mapSession,
  mapTransactionsPage,
} from "./enable-banking.mapper";

/** The id this client reports under. Must match `TRACKED_PROVIDERS`. */
export const ENABLE_BANKING_PROVIDER = "enable_banking";

/** The provider host is fixed, so no SSRF guard is needed (plan assumption 4). */
export const ENABLE_BANKING_BASE_URL = "https://api.enablebanking.com";

/** Each request to the provider is abandoned after this long. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** A fetch of transactions stops here; beyond it the sync fails rather than truncates. */
export const MAX_TRANSACTION_PAGES = 100;

const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_DESCRIPTION_LENGTH = 200;
const MAX_ERROR_BODY_LENGTH = 4000;
const MAX_PSU_HEADER_LENGTH = 256;

/**
 * What the `error` field of an Enable Banking `ErrorResponse` decides, from the
 * `ErrorCode` schema of its API reference. The reference maps no code to a
 * status, and its FAQ says to "base their logic on errors rather than response
 * codes" because a 401 occurs for several errors, so a code outranks the status
 * and the status decides only what carries no code (the application-level
 * refusals, e.g. 403 "Application does not exist", have none).
 */
/** The consent, not the application, is gone: the user authorizes again. */
const SESSION_GONE_CODES: ReadonlySet<string> = new Set([
  "EXPIRED_SESSION",
  "REVOKED_SESSION",
  "CLOSED_SESSION",
  "SESSION_DOES_NOT_EXIST",
]);
/** The application's own credentials or access are refused. */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "UNAUTHORIZED_ACCESS",
  "AUTHORIZATION_NOT_PROVIDED",
]);
/** The bank failed or did not answer; the FAQ says to retry later. */
const BANK_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "ASPSP_ERROR",
  "ASPSP_TIMEOUT",
]);

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  psu?: PsuContext | null;
  /** False for a call whose answer has no body to read (session delete). */
  readBody?: boolean;
  /** What is being done, for the one log line a transport failure earns. */
  context: string;
}

/** A header value the platform will accept: printable ASCII, bounded. */
function headerValue(value: string): string | null {
  const cleaned = value.replace(/[^ -~]+/g, " ").trim();
  return cleaned === "" ? null : cleaned.slice(0, MAX_PSU_HEADER_LENGTH);
}

/**
 * A JWT, whole or cut short: every token this client signs begins `eyJ` (the
 * base64url of `{"`) and has up to three dot-separated segments.
 */
const JWT_SHAPE = /eyJ[\w-]*(?:\.[\w-]*){0,2}/g;

/**
 * `value` with the signed token removed wherever it appears, including a copy
 * that a bounded message has cut short, which an exact match would miss.
 */
function redactToken(value: string, token: string): string {
  return value.split(token).join("[redacted]").replace(JWT_SHAPE, "[redacted]");
}

/** The kind of a refusal (see `SESSION_GONE_CODES`: a code outranks the status). */
function kindOf(
  status: number,
  code: string | null,
): BankSyncProviderErrorKind {
  if (code !== null) {
    if (SESSION_GONE_CODES.has(code)) return "session_expired";
    if (code === "UNAUTHORIZED_IP") return "ip_not_allowed";
    if (code === "NO_ACCOUNTS_ADDED") return "no_accounts_linked";
    if (code === "WRONG_TRANSACTIONS_PERIOD") return "period_unavailable";
    if (code === "ASPSP_RATE_LIMIT_EXCEEDED") return "rate_limited";
    if (BANK_UNAVAILABLE_CODES.has(code)) return "unavailable";
    if (CREDENTIAL_CODES.has(code)) return "unauthorized";
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  // 408 is in the reference's list of answers: the bank did not reply in time.
  if (status === 408 || status >= 500) return "unavailable";
  if (status >= 400) return "bad_request";
  // A 1xx or 3xx that `fetch` did not follow: nothing this build expects.
  return "invalid_response";
}

/**
 * The Enable Banking adapter, and the only place this deployment talks to
 * `api.enablebanking.com`.
 *
 * Availability goes through `ProviderHealthService` in the shape
 * `GooglePlacesClient` documents: a non-2xx is a complete answer and is
 * recorded the moment it arrives, a 2xx only once its BODY has arrived, and an
 * error the breaker did not count hands a held probe slot back.
 * `provider-call.guard.spec.ts` holds this shape.
 *
 * Every failure leaves as a `BankSyncProviderError` whose message is bounded
 * and built from the status and the provider's own error code and description
 * only. The signed JWT and the private key never reach a message or a log
 * line, and any occurrence of the token in a provider description is redacted.
 *
 * With `BANK_SYNC_LOG_RAW=true` each answer that carries bank data (a page of
 * transactions, the balances, an account's details, a new session) is also
 * written to the debug log, identifiers masked (`enable-banking-raw-log.ts`).
 * Off by default: that log holds counterparty names, remittance text and amounts.
 */
@Injectable()
export class EnableBankingProvider implements BankSyncProvider {
  readonly name = "enable_banking" as const;
  private readonly logger = new Logger(EnableBankingProvider.name);

  constructor(
    private readonly health: ProviderHealthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether the operator asked for the raw answers in the debug log. Read on
   * each use, and only the exact value `true` turns it on: the Nest logger
   * prints debug lines unconditionally in this app, so this flag is the gate.
   */
  private logsRawAnswers(): boolean {
    return this.config.get<string>("BANK_SYNC_LOG_RAW") === "true";
  }

  /** The masked, bounded debug lines of one answer; nothing unless the flag is on. */
  private logRaw(
    label: string,
    accountUid: string | null,
    payload: unknown,
    page?: number,
  ): void {
    if (!this.logsRawAnswers()) return;
    for (const line of rawLogLines({ label, accountUid, page, payload })) {
      this.logger.debug(line);
    }
  }

  async testCredentials(
    credentials: BankSyncCredentials,
  ): Promise<{ applicationName: string | null; redirectUrls: string[] }> {
    const payload = await this.request(credentials, {
      method: "GET",
      path: "/application",
      context: "credentials check",
    });
    return mapApplication(payload);
  }

  async listInstitutions(
    credentials: BankSyncCredentials,
    country: string,
  ): Promise<BankInstitution[]> {
    const payload = await this.request(credentials, {
      method: "GET",
      path: "/aspsps",
      // Only banks that offer account information: the list also holds banks
      // reachable for payment initiation alone, which cannot be authorized here.
      query: { country, service: "AIS" },
      context: `institution list for ${country}`,
    });
    return mapInstitutions(payload);
  }

  async startAuthorization(
    credentials: BankSyncCredentials,
    input: StartAuthorizationInput,
  ): Promise<{ url: string }> {
    const payload = await this.request(credentials, {
      method: "POST",
      path: "/auth",
      body: {
        access: { valid_until: input.validUntil.toISOString() },
        aspsp: { name: input.institutionName, country: input.country },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: input.psuType,
      },
      context: "authorization start",
    });
    return { url: mapAuthorizationUrl(payload) };
  }

  async completeAuthorization(
    credentials: BankSyncCredentials,
    code: string,
  ): Promise<{
    sessionId: string;
    validUntil: Date | null;
    accounts: BankAccountDescriptor[];
  }> {
    const payload = await this.request(credentials, {
      method: "POST",
      path: "/sessions",
      body: { code },
      context: "session creation",
    });
    this.logRaw("session", null, payload);
    return mapSession(payload);
  }

  async fetchTransactions(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    window: { dateFrom: string; dateTo: string },
    psu: PsuContext | null,
  ): Promise<BankTransaction[]> {
    const rows: BankTransaction[] = [];
    const seenKeys = new Set<string>();
    let continuationKey: string | null = null;
    // `date_from` is read in UTC and a date after today is refused
    // (`DATE_FROM_IN_FUTURE`); the caller's day is the user's, which can be one
    // ahead of UTC. Reading from the UTC day returns a superset, and the planner
    // applies the cut-off.
    const utcToday = new Date().toISOString().slice(0, 10);
    const dateFrom = window.dateFrom > utcToday ? utcToday : window.dateFrom;

    for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
      const payload = await this.request(credentials, {
        method: "GET",
        path: `/accounts/${encodeURIComponent(externalAccountId)}/transactions`,
        query: {
          date_from: dateFrom,
          date_to: window.dateTo,
          transaction_status: "BOOK",
          ...(continuationKey ? { continuation_key: continuationKey } : {}),
        },
        psu,
        context: "transaction fetch",
      });
      this.logRaw("transactions", externalAccountId, payload, page + 1);
      const result = mapTransactionsPage(payload);
      // Also filtered here: the status parameter is a request, not a promise.
      rows.push(...result.transactions.filter((row) => row.booked));

      if (result.continuationKey === null) return rows;
      // A key the provider hands back twice would loop for ever.
      if (seenKeys.has(result.continuationKey)) {
        throw new BankSyncProviderError(
          "invalid_response",
          "Enable Banking repeated a pagination key.",
        );
      }
      seenKeys.add(result.continuationKey);
      continuationKey = result.continuationKey;
    }
    // A partial list reported as success would advance the sync window over
    // rows never read, so running out of pages is a failure.
    throw new BankSyncProviderError(
      "invalid_response",
      `Enable Banking returned more than ${MAX_TRANSACTION_PAGES} pages of transactions.`,
    );
  }

  async fetchAccountDetails(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    psu: PsuContext | null,
  ): Promise<BankAccountDescriptor> {
    const payload = await this.request(credentials, {
      method: "GET",
      path: `/accounts/${encodeURIComponent(externalAccountId)}/details`,
      psu,
      context: "account details fetch",
    });
    this.logRaw("account details", externalAccountId, payload);
    return mapAccountDetails(payload, externalAccountId);
  }

  async fetchBalance(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    psu: PsuContext | null,
  ): Promise<BankBalance | null> {
    const payload = await this.request(credentials, {
      method: "GET",
      path: `/accounts/${encodeURIComponent(externalAccountId)}/balances`,
      psu,
      context: "balance fetch",
    });
    this.logRaw("balances", externalAccountId, payload);
    return mapBalance(payload);
  }

  async revokeSession(
    credentials: BankSyncCredentials,
    sessionId: string,
  ): Promise<void> {
    await this.request(credentials, {
      method: "DELETE",
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      readBody: false,
      context: "session revocation",
    });
  }

  /**
   * One authenticated call: the breaker gate, the request, the recording of
   * whichever way it ended, and the mapping of a refusal to a typed error.
   * Returns the parsed body (null when `readBody` is false).
   */
  private async request(
    credentials: BankSyncCredentials,
    options: RequestOptions,
  ): Promise<unknown> {
    // Before the breaker is consulted: a key that cannot sign is this user's
    // configuration, neither an outcome for the provider nor a probe worth holding.
    const token = signEnableBankingJwt(credentials);

    const admission = this.admit();
    const url = this.urlFor(options);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...this.psuHeaders(options.psu ?? null),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.reportFailure(admission, options.context, error);
      throw this.transportError(error, token);
    }

    if (!response.ok) {
      // A complete answer with nothing left to trust: the provider is up.
      this.health.recordSuccess(ENABLE_BANKING_PROVIDER);
      throw await this.rejection(response, token);
    }

    let payload: unknown = null;
    if (options.readBody !== false) {
      try {
        payload = await response.json();
      } catch (error) {
        // A body that never finished arriving is a transport failure after the
        // headers, so it is counted here or a stalling host never opens the
        // breaker; an unparseable one is not counted at all.
        this.reportFailure(admission, options.context, error);
        throw isTransportFailure(error)
          ? this.transportError(error, token)
          : new BankSyncProviderError(
              "invalid_response",
              "Enable Banking returned an unreadable response.",
              response.status,
            );
      }
    }
    this.health.recordSuccess(ENABLE_BANKING_PROVIDER);
    return payload;
  }

  /** The breaker gate, with a refusal reported in this feature's own terms. */
  private admit(): "open-gate" | "probe" {
    try {
      return this.health.assertAvailable(ENABLE_BANKING_PROVIDER);
    } catch (error) {
      if (isProviderUnavailable(error)) {
        throw new BankSyncProviderError(
          "unavailable",
          "Enable Banking is temporarily unavailable. Try again later.",
        );
      }
      throw error;
    }
  }

  private urlFor(options: RequestOptions): string {
    const query = new URLSearchParams(options.query ?? {}).toString();
    return `${ENABLE_BANKING_BASE_URL}${options.path}${query ? `?${query}` : ""}`;
  }

  /**
   * The PSU headers of a user-present read. Values are reduced to printable
   * ASCII first: `fetch` quotes a rejected header value in its error, and a
   * user agent is the user's to choose.
   */
  private psuHeaders(psu: PsuContext | null): Record<string, string> {
    if (!psu) return {};
    const ip = headerValue(psu.ipAddress);
    const userAgent = headerValue(psu.userAgent);
    return {
      ...(ip ? { "Psu-Ip-Address": ip } : {}),
      ...(userAgent ? { "Psu-User-Agent": userAgent } : {}),
    };
  }

  /**
   * Count and log one failed attempt, and give back the probe slot when the
   * breaker did not count it. Only the probe holder may hand the slot back.
   */
  private reportFailure(
    admission: "open-gate" | "probe",
    context: string,
    error: unknown,
  ): void {
    const counted = this.health.recordFailure(ENABLE_BANKING_PROVIDER, error);
    if (!counted && admission === "probe") {
      this.health.releaseProbe(ENABLE_BANKING_PROVIDER);
    }
    this.health.logFailure(
      this.logger,
      ENABLE_BANKING_PROVIDER,
      context,
      error,
    );
  }

  private transportError(error: unknown, token: string): BankSyncProviderError {
    return new BankSyncProviderError(
      "unavailable",
      `Enable Banking did not answer: ${redactToken(describeFetchFailure(error), token)}`,
    );
  }

  /**
   * A non-2xx answer as a typed error. The provider's `error` code and
   * `message` are read from the body, bounded and stripped, because "the
   * session has expired" and "this request is malformed" send the user to
   * different repairs and a bare status cannot tell them apart.
   */
  private async rejection(
    response: Response,
    token: string,
  ): Promise<BankSyncProviderError> {
    const { code, description } = await this.readError(response, token);
    const status = response.status;
    const detail =
      (code ? `: ${code}` : "") + (description ? ` (${description})` : "");
    const message = `Enable Banking returned HTTP ${status}${detail}`;
    return new BankSyncProviderError(
      kindOf(status, code),
      message,
      status,
      code,
    );
  }

  /**
   * An `ErrorResponse` has `message`, an integer `code` that repeats the HTTP
   * status, the text `error` code and a free-form `detail`. Only `error` is the
   * provider's code: the integer is the status again, and an answer from the
   * gateway before the application is known (an unknown application id, a
   * missing header) carries no `error` at all.
   */
  private async readError(
    response: Response,
    token: string,
  ): Promise<{ code: string | null; description: string | null }> {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(
        (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH),
      );
    } catch {
      // A refusal with an unreadable body is still a refusal.
    }
    const body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    return {
      code:
        this.safeText(
          typeof body.error === "string" ? body.error : null,
          MAX_ERROR_CODE_LENGTH,
          token,
        )?.toUpperCase() ?? null,
      description:
        this.safeText(body.message, MAX_ERROR_DESCRIPTION_LENGTH, token) ??
        this.safeText(body.detail, MAX_ERROR_DESCRIPTION_LENGTH, token),
    };
  }

  /** Printable, bounded, and never the token, wherever the provider echoed it. */
  private safeText(value: unknown, max: number, token: string): string | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const cleaned = redactToken(String(value), token)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim();
    return cleaned === "" ? null : cleaned.slice(0, max);
  }
}
