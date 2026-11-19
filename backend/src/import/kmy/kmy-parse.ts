import type { CountryCode } from "libphonenumber-js/max";
import type { MnyParsedFile } from "../mny/mny-parser.service";
import type { MnyImportOptions } from "../mny/model/mny-import-options";
import { mapKmyFileYielding } from "./map/kmy-map-file";
import { KmyImportError, KmyMappingFailedError } from "./model/kmy-errors";
import { readKmyFile } from "./reader/kmy-read-file";

export interface ParseKmyBytesInput {
  /** Uploaded or staged bytes, as they arrived. Not mutated. */
  readonly bytes: Buffer;
  readonly filename: string;
  /** Bound on the inflated XML (`KMY_MAX_XML_BYTES`). */
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
 * Pure apart from its inputs, so the parser service (the preview request and
 * the import job alike) and the corpus script share one path. The reader
 * streams and yields to the event loop as it goes; the mapper then runs
 * synchronously over the raw model, whose size the reader bounds.
 */
export async function parseKmyBytes(
  input: ParseKmyBytesInput,
): Promise<MnyParsedFile> {
  const raw = await readKmyFile({
    bytes: input.bytes,
    filename: input.filename,
    maxXmlBytes: input.maxXmlBytes,
  });
  try {
    return await mapKmyFileYielding(raw, {
      options: input.options,
      userDefaultCurrency: input.userDefaultCurrency,
      phoneRegion: input.phoneRegion,
      coinDecimals: input.coinDecimals,
      asOf: input.asOf,
    });
  } catch (err) {
    // The reader accepted the file, so a failure here is Monize's own
    // defect: typed, so neither the preview nor the job reports it as a
    // damaged file or as worth retrying.
    if (err instanceof KmyImportError) {
      throw err;
    }
    throw new KmyMappingFailedError(err);
  }
}
