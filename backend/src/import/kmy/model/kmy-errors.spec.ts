import { MnyImportError } from "../../mny/mny-errors";
import {
  KmyAnonymizedFileError,
  KmyCorruptFileError,
  KmyEncryptedFileError,
  KmyImportError,
  KmyLegacyBinaryFileError,
  KmyNotAKmyMoneyFileError,
  KmySqliteDatabaseError,
  KmyXmlTooLargeError,
} from "./kmy-errors";

describe("kmy errors", () => {
  const cases: Array<[string, KmyImportError]> = [
    ["kmyNotAKmyMoneyFile", new KmyNotAKmyMoneyFileError()],
    ["kmyEncryptedFile", new KmyEncryptedFileError()],
    ["kmySqliteDatabase", new KmySqliteDatabaseError()],
    ["kmyAnonymizedFile", new KmyAnonymizedFileError()],
    ["kmyLegacyBinaryFile", new KmyLegacyBinaryFileError()],
    ["kmyCorruptFile", new KmyCorruptFileError("bad tag")],
    ["kmyXmlTooLarge", new KmyXmlTooLargeError(512)],
  ];

  it.each(cases)("%s carries its code and is a MnyImportError", (code, err) => {
    expect(err.code).toBe(code);
    expect(err).toBeInstanceOf(KmyImportError);
    expect(err).toBeInstanceOf(MnyImportError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("Error");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("names the detail and keeps the cause for a corrupt file", () => {
    const cause = new Error("inner");
    const err = new KmyCorruptFileError("bad tag", cause);
    expect(err.message).toContain("bad tag");
    expect(err.cause).toBe(cause);
  });

  it("names the limit for an oversized file", () => {
    expect(new KmyXmlTooLargeError(512).message).toContain("512");
  });
});
