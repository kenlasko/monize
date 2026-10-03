import {
  extractMailText,
  MAIL_TEXT_MAX_BODY_CHARS,
  MAIL_TEXT_MAX_FROM_ADDRESS_CHARS,
  MAIL_TEXT_MAX_MESSAGE_ID_CHARS,
  MAIL_TEXT_MAX_SUBJECT_CHARS,
  stripControlCharacters,
} from "./mail-text.util";

/** A message built from header lines and a body, CRLF throughout. */
function mime(headers: string[], body: string): Buffer {
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "latin1");
}

const BASE = [
  "From: Shop <Orders@Shop.Example.COM>",
  "To: receipts@example.com",
  "Subject: Your order #123",
  "Message-ID: <abc123@shop.example.com>",
  "Date: Tue, 29 Sep 2026 10:30:00 +0000",
  "MIME-Version: 1.0",
];

describe("extractMailText", () => {
  it("reads a plain text message: headers, lower-case sender and domain, body", async () => {
    const result = await extractMailText(
      mime(
        [...BASE, "Content-Type: text/plain; charset=utf-8"],
        "Order total: 49.99\r\nThanks!\r\n",
      ),
    );

    expect(result.fromAddress).toBe("orders@shop.example.com");
    expect(result.fromDomain).toBe("shop.example.com");
    expect(result.subject).toBe("Your order #123");
    expect(result.messageId).toBe("<abc123@shop.example.com>");
    expect(result.date?.toISOString()).toBe("2026-09-29T10:30:00.000Z");
    expect(result.text).toBe("Order total: 49.99\nThanks!\n");
  });

  it("converts an HTML-only message to text", async () => {
    const result = await extractMailText(
      mime(
        [...BASE, "Content-Type: text/html; charset=utf-8"],
        "<html><body><h1>Receipt</h1><p>Item A &amp; B: <b>10.00</b></p>" +
          "<script>alert(1)</script></body></html>",
      ),
    );

    expect(result.text).toContain("Item A & B: 10.00");
    expect(result.text).toContain("RECEIPT");
    expect(result.text).not.toContain("<b>");
    expect(result.text).not.toContain("<p>");
  });

  it("prefers the plain part of a multipart/alternative message", async () => {
    const boundary = "BOUNDARY-1";
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain version: total 12.00",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML version: total <b>99.00</b></p>",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const result = await extractMailText(
      mime(
        [
          ...BASE,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ],
        body,
      ),
    );

    expect(result.text).toContain("Plain version: total 12.00");
    expect(result.text).not.toContain("99.00");
  });

  it("converts the HTML of a multipart/mixed message that has no plain part", async () => {
    // mailparser leaves `text` empty here; the fallback converts the HTML.
    const boundary = "BOUNDARY-2";
    const body = [
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Order total: <b>31.40</b></p>",
      `--${boundary}`,
      "Content-Type: application/octet-stream; name=x.bin",
      "Content-Disposition: attachment; filename=x.bin",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("not part of the text").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const result = await extractMailText(
      mime(
        [...BASE, `Content-Type: multipart/mixed; boundary="${boundary}"`],
        body,
      ),
    );

    expect(result.text).toContain("Order total: 31.40");
    expect(result.text).not.toContain("not part of the text");
  });

  it("decodes quoted-printable", async () => {
    const result = await extractMailText(
      mime(
        [
          ...BASE,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
        ],
        "Total: 10=2E50 z=C5=82 =E2=80=94 caf=C3=A9\r\nlong line that is soft=\r\n wrapped\r\n",
      ),
    );

    expect(result.text).toContain("Total: 10.50 zł — café");
    expect(result.text).toContain("soft wrapped");
  });

  it("decodes the ISO-8859-2 charset", async () => {
    // 0xB3 is ł, 0xA1 is Ą, 0xEA is ę in ISO-8859-2.
    const result = await extractMailText(
      Buffer.concat([
        Buffer.from(
          [
            ...BASE,
            "Content-Type: text/plain; charset=iso-8859-2",
            "Content-Transfer-Encoding: 8bit",
            "",
            "",
          ].join("\r\n"),
          "latin1",
        ),
        Buffer.from([
          ...Buffer.from("Zam", "latin1"),
          0xf3,
          ...Buffer.from("wienie: ", "latin1"),
          0xa1,
          ...Buffer.from("r", "latin1"),
          0xea,
          ...Buffer.from("kawiczki ", "latin1"),
          0xb3,
          ...Buffer.from("adne", "latin1"),
        ]),
      ]),
    );

    expect(result.text).toBe("Zamówienie: Ąrękawiczki ładne");
  });

  it("decodes an RFC 2047 encoded subject", async () => {
    const result = await extractMailText(
      mime(
        [
          "From: a@b.example",
          "Subject: =?UTF-8?B?WmFtw7N3aWVuaWUgbnIgNDU2?=",
          "Content-Type: text/plain; charset=utf-8",
        ],
        "x",
      ),
    );

    expect(result.subject).toBe("Zamówienie nr 456");
  });

  it("strips NUL and other control characters but keeps newline and tab", async () => {
    const result = await extractMailText(
      mime(
        [...BASE, "Content-Type: text/plain; charset=utf-8"],
        "a\u0000b\u0007c\td\u001be\r\nf\u007fgh\r\n",
      ),
    );

    expect(result.text).toBe("abc\tde\nfgh\n");
    expect(result.text).not.toContain("\u0000");
  });

  it("reduces a subject to one bounded line", async () => {
    const result = await extractMailText(
      mime(
        [
          "From: a@b.example",
          `Subject: ${"word ".repeat(200)}`,
          "Content-Type: text/plain",
        ],
        "x",
      ),
    );

    expect(result.subject.length).toBeLessThanOrEqual(
      MAIL_TEXT_MAX_SUBJECT_CHARS,
    );
    expect(result.subject).not.toMatch(/\s{2}/);
    expect(result.subject.startsWith("word word")).toBe(true);
  });

  it("caps the body, the sender and the Message-ID at their column widths", async () => {
    const longLocal = "x".repeat(400);
    const longId = `<${"i".repeat(700)}@example.com>`;
    const result = await extractMailText(
      mime(
        [
          `From: ${longLocal}@shop.example.com`,
          `Message-ID: ${longId}`,
          "Subject: s",
          "Content-Type: text/plain; charset=utf-8",
        ],
        "y".repeat(MAIL_TEXT_MAX_BODY_CHARS + 5000),
      ),
    );

    expect(result.text.length).toBe(MAIL_TEXT_MAX_BODY_CHARS);
    expect(result.fromAddress.length).toBeLessThanOrEqual(
      MAIL_TEXT_MAX_FROM_ADDRESS_CHARS,
    );
    expect(result.fromDomain.length).toBeLessThanOrEqual(255);
    expect(result.messageId?.length).toBeLessThanOrEqual(
      MAIL_TEXT_MAX_MESSAGE_ID_CHARS,
    );
  });

  it("answers empty strings and nulls for a message with no sender, id, date or body", async () => {
    const result = await extractMailText(
      Buffer.from("Subject: bare\r\n\r\n", "latin1"),
    );

    expect(result).toEqual({
      messageId: null,
      fromAddress: "",
      fromDomain: "",
      subject: "bare",
      date: null,
      text: "",
    });
  });

  it("ignores an unreadable Date header", async () => {
    const result = await extractMailText(
      mime(
        ["From: a@b.example", "Date: not a date", "Content-Type: text/plain"],
        "x",
      ),
    );

    expect(result.date).toBeNull();
  });
});

describe("stripControlCharacters", () => {
  it("normalises CRLF and a lone CR to LF", () => {
    expect(stripControlCharacters("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("removes DEL and the C1 controls too", () => {
    expect(stripControlCharacters("a\u007fb\u0085c\u009fd")).toBe("abcd");
  });

  it("keeps printable non-ASCII text", () => {
    expect(stripControlCharacters("zażółć gęślą jaźń 日本")).toBe(
      "zażółć gęślą jaźń 日本",
    );
  });
});
