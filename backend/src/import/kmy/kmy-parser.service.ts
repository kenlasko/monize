import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { preferredCurrency } from "../../common/default-currency.util";
import { phoneRegionFromPreferences } from "../../common/phone-number.util";
import { Currency } from "../../currencies/entities/currency.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { todayYMD } from "../../common/date-utils";
import { type MnyParsedFile } from "../mny/mny-parser.service";
import type {
  ImportSourceParseInput,
  ImportSourceParser,
} from "../mny/model/import-source";
import { parseKmyBytes } from "./kmy-parse";
import { KMY_MAX_XML_BYTES } from "./reader/kmy-limits";

/**
 * The KMyMoney side of the shared parser seam. Reads the two things the pure
 * mapper needs from the database (the user's currency and phone-region preferences and which
 * currencies are coins), releases the connection, then parses.
 */
@Injectable()
export class KmyParserService implements ImportSourceParser {
  readonly sourceFormat = "kmy" as const;

  constructor(private readonly dataSource: DataSource) {}

  async parse(input: ImportSourceParseInput): Promise<MnyParsedFile> {
    const { userDefaultCurrency, phoneRegion, coinDecimals } =
      await withScopedDb(this.dataSource, async (manager) => {
        // One read of the preference row serves the currency and the phone
        // region, so the preview and the job normalize numbers alike.
        const preference = await manager
          .getRepository(UserPreference)
          .findOne({ where: { userId: input.userId } });
        const currency =
          input.userDefaultCurrency ?? preferredCurrency(preference);
        const coins = await manager.getRepository(Currency).find({
          select: { code: true, decimalPlaces: true },
          where: { kind: "CRYPTO" },
        });
        return {
          userDefaultCurrency: currency,
          phoneRegion: phoneRegionFromPreferences(preference),
          coinDecimals: new Map(
            coins.map((coin) => [coin.code, coin.decimalPlaces] as const),
          ),
        };
      });

    return parseKmyBytes({
      bytes: input.buffer,
      filename: input.filename,
      maxXmlBytes: KMY_MAX_XML_BYTES,
      options: input.options,
      userDefaultCurrency,
      phoneRegion,
      coinDecimals,
      // The day post-processing computes `current_balance` at (`todayYMD`,
      // the request's time zone where there is one), so the file's figures
      // and the database's are cut off on one date.
      asOf: input.asOf ?? todayYMD(),
    });
  }
}
