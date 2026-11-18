import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { preferredCurrency } from "../../common/default-currency.util";
import { Currency } from "../../currencies/entities/currency.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { MNY_IMPORT_LIMIT_BYTES } from "../mny/mny-import.controller";
import { todayIsoDate, type MnyParsedFile } from "../mny/mny-parser.service";
import type {
  ImportSourceParseInput,
  ImportSourceParser,
} from "../mny/model/import-source";
import { parseKmyBytes } from "./kmy-parse";

/**
 * The KMyMoney side of the shared parser seam. Reads the two things the pure
 * mapper needs from the database (the user's currency preference and which
 * currencies are coins), releases the connection, then parses.
 */
@Injectable()
export class KmyParserService implements ImportSourceParser {
  readonly sourceFormat = "kmy" as const;

  constructor(private readonly dataSource: DataSource) {}

  async parse(input: ImportSourceParseInput): Promise<MnyParsedFile> {
    const { userDefaultCurrency, coinDecimals } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const currency =
          input.userDefaultCurrency ??
          preferredCurrency(
            await manager
              .getRepository(UserPreference)
              .findOne({ where: { userId: input.userId } }),
          );
        const coins = await manager.getRepository(Currency).find({
          select: { code: true, decimalPlaces: true },
          where: { kind: "CRYPTO" },
        });
        return {
          userDefaultCurrency: currency,
          coinDecimals: new Map(
            coins.map((coin) => [coin.code, coin.decimalPlaces] as const),
          ),
        };
      },
    );

    return parseKmyBytes({
      bytes: input.buffer,
      filename: input.filename,
      maxXmlBytes: MNY_IMPORT_LIMIT_BYTES,
      options: input.options,
      userDefaultCurrency,
      coinDecimals,
      asOf: input.asOf ?? todayIsoDate(),
    });
  }
}
