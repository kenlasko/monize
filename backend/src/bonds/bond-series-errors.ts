import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { SeriesFetchError, SeriesFetchErrorCode } from "./bond-adapter";

type Params = Readonly<Record<string, string>>;

/**
 * The English source of each series message, with the same `{{ param }}` names
 * as `errors.bonds.<code>` in the catalogue. `series` and `country` are named by
 * the service on every error; the rest are the adapter's short machine values.
 */
export const SERIES_ERROR_FALLBACKS: Readonly<
  Record<SeriesFetchErrorCode, (p: Params) => string>
> = {
  SERIES_CODE_INVALID: (p) => `"${p.series}" is not a valid series code`,
  SERIES_FETCH_UNSUPPORTED: (p) =>
    `Series cannot be fetched from an official source for ${p.country}`,
  SERIES_NOT_PUBLISHED: (p) =>
    `Series ${p.series} is not published on the official source`,
  SOURCE_UNAVAILABLE: (p) =>
    `The official source for series ${p.series} could not be read right now; try again later`,
  SOURCE_DOCUMENT_MISSING: (p) =>
    `The ${p.document} of series ${p.series} cannot be read from the official source (it answered ${p.status}); the series cannot be fetched, and an administrator may enter it by hand`,
  MANUAL_ENTRY_INVALID: (p) =>
    `The value entered for ${p.field} of series ${p.series} is not acceptable`,
  SOURCE_FORMAT_CHANGED: (p) =>
    `The terms of series ${p.series} have no usable ${p.field}: the official source may have changed its format, or the value is not acceptable`,
  SOURCE_INCONSISTENT: (p) =>
    `The values of series ${p.series} are inconsistent or out of bounds on ${p.field} (${p.detail})`,
  TEMPLATE_NOT_VALIDATED: (p) =>
    `Series ${p.series} was sold before the ${p.product} template was validated (${p.validFrom}); it needs a curated entry`,
  PRODUCT_NOT_SUPPORTED: (p) =>
    `Series ${p.series} is a ${p.product}, a product that is not supported yet`,
  SERIES_TERMS_CONFLICT: (p) =>
    `Series ${p.series} is already stored with different terms; stored terms are never replaced`,
};

/**
 * `detail` names the compared values whatever an adapter called them (`page` and
 * `letter`, or `value` and `expected`): the params other than the ones the
 * message names itself.
 */
function messageParams(error: SeriesFetchError): Params {
  const detail = Object.entries(error.params)
    .filter(([key]) => !["series", "country", "field"].includes(key))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return { ...error.params, detail };
}

/** The message of a refused series request, translated against the request's locale. */
export function seriesErrorMessage(error: SeriesFetchError): string {
  const params = messageParams(error);
  return tr(
    `errors.bonds.${error.code}`,
    SERIES_ERROR_FALLBACKS[error.code](params),
    { ...params },
  );
}

/**
 * The HTTP error of a refused series request. A refusal of an administrator's
 * own values (`manual`) is a 422 where the same code from a fetch means the
 * official source changed (502): the person typed the value, not the issuer.
 */
export function seriesHttpException(
  error: SeriesFetchError,
  manual: boolean,
): HttpException {
  const message = seriesErrorMessage(error);
  switch (error.code) {
    case "SERIES_CODE_INVALID":
    case "SERIES_FETCH_UNSUPPORTED":
      return new BadRequestException(message);
    case "SERIES_NOT_PUBLISHED":
      return new NotFoundException(message);
    case "SOURCE_UNAVAILABLE":
      return new ServiceUnavailableException(message);
    case "SOURCE_FORMAT_CHANGED":
      return manual
        ? new UnprocessableEntityException(message)
        : new BadGatewayException(message);
    case "SOURCE_DOCUMENT_MISSING":
    case "MANUAL_ENTRY_INVALID":
    case "SOURCE_INCONSISTENT":
    case "TEMPLATE_NOT_VALIDATED":
    case "PRODUCT_NOT_SUPPORTED":
      return new UnprocessableEntityException(message);
    case "SERIES_TERMS_CONFLICT":
      return new ConflictException(message);
  }
}
