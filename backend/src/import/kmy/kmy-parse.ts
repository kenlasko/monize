import type { CountryCode } from "libphonenumber-js/max";
import type { MnyParsedFile } from "../mny/mny-parser.service";
import type { MnyImportOptions } from "../mny/model/mny-import-options";
import { mapKmyFile } from "./map/kmy-map-file";
import { readKmyFile } from "./reader/kmy-read-file";

export interface ParseKmyBytesInput {
  /** Uploaded or staged bytes, as they arrived. Not mutated. */
  readonly bytes: Buffer;
  readonly filename: string;
  /** Bound on the inflated XML (the shared upload limit). */
  readonly maxXmlBytes: number;
  readonly options?: Partial<MnyImportOptions>;
  readonly userDefaultCurrency: string;
  /** Region a bare national phone number is read in; null names none. */
  readonly phoneRegion: CountryCode | null;
  /** CRYPTO currency code -> its decimal places. */
  readonly coinDecimals: ReadonlyMap<string, number>;
  /** YYYY-MM-DD balance cut-off. */
  readonly asOf: string;
}

/**
 * Bytes to the parsed file the shared pipeline consumes: reader, then mapper.
 * Pure and synchronous apart from its inputs, so the parser service and the
 * corpus script share one path.
 */
export function parseKmyBytes(input: ParseKmyBytesInput): MnyParsedFile {
  const raw = readKmyFile({
    bytes: input.bytes,
    filename: input.filename,
    maxXmlBytes: input.maxXmlBytes,
  });
  return mapKmyFile(raw, {
    options: input.options,
    userDefaultCurrency: input.userDefaultCurrency,
    phoneRegion: input.phoneRegion,
    coinDecimals: input.coinDecimals,
    asOf: input.asOf,
  });
}
