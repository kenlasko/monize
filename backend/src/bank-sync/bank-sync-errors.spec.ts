import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  BankSyncAlreadyRunningException,
  BankSyncCredentialsUnavailableException,
  SYNC_RUNNING_CODE,
  NEEDS_PREVIEW_CODE,
  describeFailureForClient,
  describeSyncFailure,
  isSyncFailureEntry,
  mapBankSyncProviderError,
  needsPreviewFailure,
  storedFailureMessage,
  toBankSyncException,
} from "./bank-sync-errors";
import type { BankSyncConnectionSyncEntry } from "./bank-sync.types";
import {
  BankSyncProviderError,
  BankSyncProviderErrorKind,
} from "./providers/bank-sync-provider.errors";

describe("bank-sync error mapping", () => {
  const cases: Array<[BankSyncProviderErrorKind, number, unknown]> = [
    ["unauthorized", 400, BadRequestException],
    ["session_expired", 409, ConflictException],
    ["ip_not_allowed", 400, BadRequestException],
    ["no_accounts_linked", 400, BadRequestException],
    ["period_unavailable", 400, BadRequestException],
    ["rate_limited", 429, HttpException],
    ["bad_request", 400, BadRequestException],
    ["unavailable", 503, ServiceUnavailableException],
    ["invalid_response", 502, BadGatewayException],
  ];

  it.each(cases)("maps %s to HTTP %i", (kind, status, type) => {
    const mapped = mapBankSyncProviderError(
      new BankSyncProviderError(kind, "detail from the provider", 500),
    );
    expect(mapped.getStatus()).toBe(status);
    expect(mapped).toBeInstanceOf(type as new (...args: never[]) => Error);
  });

  it.each([
    ["ip_not_allowed", /IP address/],
    ["no_accounts_linked", /Activate by linking accounts/],
    ["period_unavailable", /cut-off date/],
  ] as const)(
    "tells the user what to fix for %s, not what the provider said",
    (kind, advice) => {
      const mapped = mapBankSyncProviderError(
        new BankSyncProviderError(
          kind,
          "UNAUTHORIZED_IP from the provider",
          403,
        ),
      );
      expect(mapped.message).toMatch(advice);
      expect(mapped.message).not.toContain("from the provider");
    },
  );

  it("carries the provider's bounded detail on a rejected request only", () => {
    const rejected = mapBankSyncProviderError(
      new BankSyncProviderError("bad_request", "invalid date_from", 422),
    );
    expect(rejected.message).toContain("invalid date_from");
    const unavailable = mapBankSyncProviderError(
      new BankSyncProviderError("unavailable", "socket hang up"),
    );
    expect(unavailable.message).not.toContain("socket hang up");
  });

  describe("toBankSyncException", () => {
    it("maps a provider failure", () => {
      const mapped = toBankSyncException(
        new BankSyncProviderError("unavailable", "down"),
      );
      expect(mapped).toBeInstanceOf(ServiceUnavailableException);
    });

    it("passes anything else through unchanged", () => {
      const notFound = new NotFoundException("gone");
      const plain = new Error("boom");
      expect(toBankSyncException(notFound)).toBe(notFound);
      expect(toBankSyncException(plain)).toBe(plain);
    });
  });

  describe("storedFailureMessage", () => {
    it("stores a provider failure's own bounded message", () => {
      expect(
        storedFailureMessage(new BankSyncProviderError("unavailable", "down")),
      ).toBe("down");
    });

    it("stores the message of an HTTP exception with a string body", () => {
      expect(storedFailureMessage(new ConflictException("renew it"))).toBe(
        "renew it",
      );
    });

    it("reads the message of an HTTP exception with an object body", () => {
      expect(
        storedFailureMessage(
          new HttpException({ message: "too many", error: "x" }, 429),
        ),
      ).toBe("too many");
    });

    it("falls back to the exception's own message for an odd body", () => {
      expect(storedFailureMessage(new HttpException({ error: "x" }, 400))).toBe(
        "Http Exception",
      );
    });

    it("replaces an unexpected error with a fixed sentence, never its text", () => {
      const stored = storedFailureMessage(
        new Error("password=hunter2 in the connection string"),
      );
      expect(stored).not.toContain("hunter2");
      expect(stored).toMatch(/failed unexpectedly/);
    });

    it("is cut to the column width", () => {
      expect(
        storedFailureMessage(new ConflictException("x".repeat(900))),
      ).toHaveLength(500);
    });
  });

  describe("describeSyncFailure", () => {
    it("names the kind and status of a provider failure", () => {
      expect(
        describeSyncFailure(
          new BankSyncProviderError("rate_limited", "slow", 429),
        ),
      ).toBe("rate_limited (HTTP 429): slow");
      expect(
        describeSyncFailure(new BankSyncProviderError("unavailable", "down")),
      ).toBe("unavailable: down");
    });

    it("names the status of an HTTP exception", () => {
      expect(describeSyncFailure(new ConflictException("busy"))).toBe(
        "409: busy",
      );
    });

    it("describes any other error through the fetch-failure reader", () => {
      expect(describeSyncFailure(new TypeError("fetch failed"))).toContain(
        "fetch failed",
      );
    });
  });
});

describe("the codes a failure is reported under", () => {
  it("names unusable credentials 'credentials' and keeps them a 400 for an HTTP caller", () => {
    const error = new BankSyncCredentialsUnavailableException("enter them");
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(describeFailureForClient(error)).toEqual({
      code: "credentials",
      message: "enter them",
    });
  });

  it("names a lease held by another sync 'sync_running' and keeps it a 409", () => {
    const error = new BankSyncAlreadyRunningException("already running");
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(describeFailureForClient(error)).toEqual({
      code: "sync_running",
      message: "already running",
    });
    expect(SYNC_RUNNING_CODE).toBe("sync_running");
    // Any other 409 stays a refusal.
    expect(describeFailureForClient(new ConflictException("busy")).code).toBe(
      "refused",
    );
  });

  it("leaves every other refusal a 'refused' and a provider failure its own kind", () => {
    expect(describeFailureForClient(new BadRequestException("x")).code).toBe(
      "refused",
    );
    expect(
      describeFailureForClient(
        new BankSyncProviderError("session_expired", "x"),
      ).code,
    ).toBe("session_expired");
  });

  it("reports an account waiting for its preview under needs_preview, with a sentence of its own", () => {
    const entry = needsPreviewFailure("b1");
    expect(entry.bankAccountId).toBe("b1");
    expect(entry.error.code).toBe(NEEDS_PREVIEW_CODE);
    expect(NEEDS_PREVIEW_CODE).toBe("needs_preview");
    expect(entry.error.message).toContain("preview");
  });

  it("tells a failure entry from a result", () => {
    const failure: BankSyncConnectionSyncEntry = needsPreviewFailure("b1");
    const result = {
      bankAccountId: "b1",
      imported: 0,
    } as BankSyncConnectionSyncEntry;
    expect(isSyncFailureEntry(failure)).toBe(true);
    expect(isSyncFailureEntry(result)).toBe(false);
  });
});
