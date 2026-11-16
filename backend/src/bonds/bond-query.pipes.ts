import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { todayYMD } from "../common/date-utils";
import { ParseOptionalCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";
import { tr } from "../i18n/translate";
import { ExactDecimal } from "./domain/exact-decimal";

/** The most values one scenarios request may value (spec 13.3). */
export const MAX_SCENARIO_VALUES = 6;

const BENCHMARK_ID = /^[A-Z0-9_]{1,40}$/;
const DECIMAL = /^-?\d{1,3}(\.\d{1,10})?$/;
const LOWER = ExactDecimal.parse("-0.5");
const UPPER = ExactDecimal.parse("1.0");

/** A benchmark value as a fraction between -0.5 and 1.0; the text as given, or null. */
function boundedFraction(value: unknown): string | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const parsed = ExactDecimal.parse(value);
  return parsed.cmp(LOWER) < 0 || parsed.cmp(UPPER) > 0 ? null : value;
}

function isBenchmarkId(value: unknown): value is string {
  return typeof value === "string" && BENCHMARK_ID.test(value);
}

/**
 * `assume=<benchmarkId>:<value>` of the valuation route as the engine's
 * projection map; absent or empty is no assumption. The type is checked before
 * the text, so a repeated key (an array) is refused rather than coerced.
 */
@Injectable()
export class ParseAssumePipe implements PipeTransform<
  unknown,
  ReadonlyMap<string, string> | undefined
> {
  transform(value: unknown): ReadonlyMap<string, string> | undefined {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string") {
      const at = value.indexOf(":");
      const benchmarkId = at < 0 ? null : value.slice(0, at);
      const fraction = at < 0 ? null : boundedFraction(value.slice(at + 1));
      if (isBenchmarkId(benchmarkId) && fraction !== null) {
        return new Map([[benchmarkId, fraction]]);
      }
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.assumeInvalid",
        "assume must be benchmarkId:value, with a benchmark id of 1 to 40 capital letters, digits or underscores and a decimal value between -0.5 and 1.0",
      ),
    );
  }
}

/** `benchmarkId` of the scenarios route. */
@Injectable()
export class ParseBenchmarkIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (isBenchmarkId(value)) return value;
    throw new BadRequestException(
      tr(
        "errors.bonds.benchmarkIdInvalid",
        "benchmarkId must be 1 to 40 capital letters, digits or underscores",
      ),
    );
  }
}

/** `values=a,b,c` of the scenarios route: 1 to 6 decimals between -0.5 and 1.0. */
@Injectable()
export class ParseScenarioValuesPipe implements PipeTransform<
  unknown,
  readonly string[]
> {
  transform(value: unknown): readonly string[] {
    if (typeof value === "string") {
      const parts = value.split(",").map((part) => part.trim());
      if (parts.length >= 1 && parts.length <= MAX_SCENARIO_VALUES) {
        const fractions = parts.map(boundedFraction);
        if (fractions.every((f): f is string => f !== null)) return fractions;
      }
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.scenarioValuesInvalid",
        "values must be 1 to 6 comma-separated decimals between -0.5 and 1.0",
      ),
    );
  }
}

/**
 * `asOf` of the valuation and scenarios routes: a real calendar date, not after
 * the caller's today (the request timezone's, as `todayYMD` answers); absent is
 * today. A later date would ask for observations nobody has published, and a
 * projection is the scenarios' job, not a valuation's. ISO dates compare as text.
 */
@Injectable()
export class ParseBondAsOfPipe implements PipeTransform<
  unknown,
  string | undefined
> {
  private readonly date = new ParseOptionalCalendarDatePipe();

  transform(value: unknown): string | undefined {
    const asOf = this.date.transform(value);
    const today = todayYMD();
    if (asOf !== undefined && asOf > today) {
      throw new BadRequestException(
        tr(
          "errors.bonds.AS_OF_IN_FUTURE",
          `The valuation date ${asOf} is after today (${today}); a bond is valued as of today or an earlier day`,
          { asOf, today },
        ),
      );
    }
    return asOf;
  }
}

/**
 * `countryCode` of the offer and history routes: two letters, upper-cased. The
 * type is checked before the text, so a repeated key (an array) is refused
 * rather than coerced.
 */
@Injectable()
export class ParseBondCountryCodePipe implements PipeTransform<
  unknown,
  string
> {
  transform(value: unknown): string {
    if (typeof value === "string") {
      const upper = value.toUpperCase();
      if (/^[A-Z]{2}$/.test(upper)) return upper;
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.countryCodeInvalid",
        "countryCode must be a two-letter country code",
      ),
    );
  }
}

/** `programCode` of the history route: 1 to 12 capital letters or digits; absent is every program. */
@Injectable()
export class ParseOptionalProgramCodePipe implements PipeTransform<
  unknown,
  string | undefined
> {
  transform(value: unknown): string | undefined {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string" && /^[A-Z0-9]{1,12}$/.test(value)) {
      return value;
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.programCodeInvalid",
        "programCode must be 1 to 12 capital letters or digits",
      ),
    );
  }
}

/** The most bonds one redemption split may ask about (a whole number of bonds). */
export const MAX_REDEMPTION_QUANTITY = 1_000_000_000;

/**
 * `quantity` of the redemption-split route: a positive whole number of bonds up
 * to `MAX_REDEMPTION_QUANTITY`, written as plain digits, answered as the text
 * the handler converts. The handler parameter is declared `string`, so the
 * global `ValidationPipe` (`createGlobalValidationPipe`) hands this pipe the
 * query text as `String(value)`; a `number` parameter ends in Nest's
 * `ParseIntPipe` instead (`global-validation-param-pipes.guard.spec.ts`), and
 * Nest's own conversion would have read `0x10` as 16 and `2.9999999999999999`
 * as 3 (issue 2221). A repeated key arrives joined (`4,5`) and fails the
 * digits; a direct caller's value of any type other than text is refused.
 */
@Injectable()
export class ParseBondQuantityPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (
      typeof value === "string" &&
      /^[1-9]\d{0,9}$/.test(value) &&
      Number(value) <= MAX_REDEMPTION_QUANTITY
    ) {
      return value;
    }
    throw quantityInvalidException(typeof value === "string" ? value : "");
  }
}

/**
 * The 400 of a redemption quantity that is not a positive whole number of
 * bonds, from the route's pipe or from `BondHoldingsService.redemptionSplit`
 * itself. `QUANTITY_INVALID` is its `errorCode`, so a client can tell the
 * refused quantity from a request that failed; `quantity` is the refused text.
 */
export function quantityInvalidException(
  quantity: string,
): BadRequestException {
  return new BadRequestException({
    message: tr(
      "errors.bonds.QUANTITY_INVALID",
      `The quantity must be a positive whole number of bonds: ${quantity}`,
      { quantity },
    ),
    errorCode: "QUANTITY_INVALID",
  });
}
