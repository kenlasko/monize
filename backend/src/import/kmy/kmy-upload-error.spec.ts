import { PayloadTooLargeException } from "@nestjs/common";
import {
  KMY_ERROR_MESSAGES,
  kmyFileTooLargeException,
} from "./kmy-upload-error";
import type { KmyErrorCode } from "./model/kmy-errors";

describe("kmy upload errors", () => {
  it("names the limit and carries the stable code", () => {
    const error = kmyFileTooLargeException(300);
    expect(error).toBeInstanceOf(PayloadTooLargeException);
    expect(error.getResponse()).toEqual({
      message: "That KMyMoney file is larger than the 300 MB import limit.",
      errorCode: "kmyFileTooLarge",
    });
  });

  it("has a non-empty message for every refusal code", () => {
    const codes: KmyErrorCode[] = [
      "kmyNotAKmyMoneyFile",
      "kmyEncryptedFile",
      "kmySqliteDatabase",
      "kmyAnonymizedFile",
      "kmyLegacyBinaryFile",
      "kmyCorruptFile",
      "kmyXmlTooLarge",
    ];
    for (const code of codes) {
      expect(KMY_ERROR_MESSAGES[code](300).length).toBeGreaterThan(10);
    }
    expect(KMY_ERROR_MESSAGES.kmyXmlTooLarge(300)).toContain("300 MB");
  });
});
