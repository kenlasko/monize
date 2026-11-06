import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { AuctionListing, BondAdapter } from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { loadLinkedSecurity } from "./bond-ledger";
import { chargeSeriesFetchAttempt } from "./series-fetch-allowance";
import { HttpFetch, SeriesHttp } from "./series-http";

/** One listed auction, and the catalog's instrument for its series when stored. */
export interface BondAuction extends AuctionListing {
  readonly instrumentId: string | null;
}

/**
 * The auctions a purchase of a security around a date could have been.
 * `supported` is false for a country whose adapter lists none (it sells in sale
 * windows, which the series-on-sale lookup answers instead); the list is then
 * empty and nothing was requested.
 */
export interface BondAuctions {
  readonly countryCode: string;
  readonly supported: boolean;
  readonly auctions: readonly BondAuction[];
}

export interface BondAuctionOptions {
  /** The network, injectable so a test never leaves the process. */
  readonly fetch?: HttpFetch;
  readonly adapters?: readonly BondAdapter[];
}

/**
 * Lists a bond program's auctions from its official source for a person
 * choosing which series a purchase was (`docs/specs/us-treasury-securities.md`
 * section 11). Asked only by a person, charged against the series fetch
 * allowance, gated like a series fetch, and nothing is stored (INV-BOND-008).
 */
@Injectable()
export class BondAuctionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly http: SeriesHttp,
    private readonly attempts: AuthAttemptCounterService,
  ) {}

  async auctionsFor(
    userId: string,
    securityId: string,
    date: string,
    options: BondAuctionOptions = {},
  ): Promise<BondAuctions> {
    const program = await withScopedDb(this.dataSource, async (m) => {
      const security = await loadLinkedSecurity(m, userId, securityId);
      const rows: Array<{
        id: string;
        issuer_country_code: string;
        program_code: string;
      }> = await m.query(
        `SELECT id, issuer_country_code, program_code
           FROM bond_programs WHERE id = $1::uuid`,
        [security.bondProgramId],
      );
      return rows[0];
    });
    if (!program) {
      throw new NotFoundException(
        tr(
          "errors.bonds.securityNotLinked",
          `Security ${securityId} not found or not linked to a bond program`,
          { securityId },
        ),
      );
    }
    const countryCode = program.issuer_country_code;
    const adapter = (options.adapters ?? INSTALLED_BOND_ADAPTERS).find(
      (a) => a.countryCode === countryCode,
    );
    const providerId = adapter?.seriesProviderId;
    if (!adapter?.auctionsNear || !providerId) {
      return { countryCode, supported: false, auctions: [] };
    }

    await chargeSeriesFetchAttempt(this.attempts, userId);
    // Outside any transaction: no connection is held while the issuer answers.
    const listings = await adapter.auctionsNear(
      program.program_code,
      date,
      this.http.gated(providerId, options.fetch),
    );
    const stored = await this.storedInstruments(
      program.id,
      listings.map((l) => l.seriesCode),
    );
    return {
      countryCode,
      supported: true,
      auctions: listings.map((l) => ({
        ...l,
        instrumentId: stored.get(l.seriesCode.toUpperCase()) ?? null,
      })),
    };
  }

  /** The catalog's instruments of the program among `codes`, by upper-cased code. */
  private async storedInstruments(
    programId: string,
    codes: readonly string[],
  ): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const rows: Array<{ id: string; series_code: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT id, series_code FROM bond_instruments
            WHERE bond_program_id = $1::uuid
              AND UPPER(series_code) = ANY($2::text[])`,
          [programId, codes.map((c) => c.toUpperCase())],
        ),
    );
    return new Map(rows.map((r) => [r.series_code.toUpperCase(), r.id]));
  }
}
