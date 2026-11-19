import { readFileSync } from "fs";
import { join } from "path";
import { test, expect } from "../fixtures";

/**
 * The KMyMoney (`.kmy`, `.xml`) import, end to end through the real wizard.
 *
 * `sample-synthetic.kmy` is the committed, hand-written fixture (the gzipped
 * form of `sample-synthetic.xml`); no file KMyMoney itself wrote is, or may be,
 * committed. It carries a checking account, a euro savings account, an
 * investment pair, a payee with a match key and a default category, a
 * schedule and prices, so the whole wizard has something to show. The mapping
 * is covered row by row by the backend specs; this proves the wizard reaches
 * each step with the file understood, ends on a verification report with no
 * differences, and refuses the containers KMyMoney can save but Monize cannot
 * read with a KMyMoney message, not Money's and not a password prompt.
 */

const FIXTURES = join(__dirname, "../../backend/src/import/kmy/__fixtures__");

const KMY_SAMPLE = join(FIXTURES, "sample-synthetic.kmy");
const XML_SAMPLE = join(FIXTURES, "sample-synthetic.xml");

/** Staging, decoding and previewing a whole profile is not a 5 s operation. */
const PARSE_TIMEOUT = 30000;
/** The import runs as a background job the wizard polls every 1.5 s. */
const IMPORT_TIMEOUT = 60000;

test.describe("KMyMoney (.kmy) import", () => {
  test("names .kmy among the formats it accepts", async ({
    authedPage: page,
  }) => {
    await page.goto("/import");

    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/KMyMoney \(\.kmy/i).first()).toBeVisible();
  });

  test("imports a KMyMoney file end to end", async ({ authedPage: page }) => {
    await page.goto("/import");
    await page.locator('input[type="file"]').setInputFiles(KMY_SAMPLE);

    // Review: the file is understood before anything is written.
    await expect(
      page.getByRole("heading", { name: /review your kmymoney file/i }),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(
      page.getByText(/KMyMoney file, format version/i),
    ).toBeVisible();
    // No KMyMoney code asks for a password, so no dialog opens.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // An investment account becomes Monize's linked cash + brokerage pair.
    await expect(page.getByText("Brokerage Account - Cash")).toBeVisible();
    await expect(page.getByText("Brokerage Account - Brokerage")).toBeVisible();
    // The sample's "City Power" payee has a match key and a default category,
    // which the review reports as a payee-alias tile.
    await expect(page.getByText("Payee aliases").first()).toBeVisible();
    await expect(
      page.getByText(/payee gets a default category/i),
    ).toBeVisible();
    // The options card is part of the step the user decides on.
    await expect(page.getByText(/skip the unused ones/i).first()).toBeVisible();

    await page.getByRole("button", { name: /start import/i }).click();

    // Import runs in the background; the wizard polls the job.
    await expect(
      page.getByRole("heading", { name: /import finished/i }),
    ).toBeVisible({ timeout: IMPORT_TIMEOUT });
    // Zero differences: every account reconciles, and the "do not match"
    // wording of a report with differences never appears.
    await expect(page.getByText(/accounts reconcile/i)).toBeVisible();
    await expect(page.getByText(/do not match/i)).toHaveCount(0);
    await expect(page.getByText("From KMyMoney file").first()).toBeVisible();

    await page.getByRole("button", { name: /^done$/i }).click();
    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible();

    // The accounts really landed, not just the report.
    await page.goto("/accounts");
    await expect(page.getByText("Checking", { exact: true })).toBeVisible({
      timeout: 15000,
    });
  });

  test("reads a plain .xml save the same way", async ({ authedPage: page }) => {
    await page.goto("/import");
    await page.locator('input[type="file"]').setInputFiles(XML_SAMPLE);

    await expect(
      page.getByRole("heading", { name: /review your kmymoney file/i }),
    ).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(page.getByText("Brokerage Account - Cash")).toBeVisible();
  });

  test.describe("an .xml file is routed by its contents", () => {
    const OFX_XML = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
      "<OFX>",
      "<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>",
      "<BANKACCTFROM><BANKID>1</BANKID><ACCTID>2</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>",
      "<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240105</DTPOSTED>",
      "<TRNAMT>-12.50</TRNAMT><FITID>X1</FITID><NAME>Corner Cafe</NAME></STMTTRN></BANKTRANLIST>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1>",
      "</OFX>",
    ].join("\n");

    test("sends an OFX 2.x document saved as .xml to the OFX flow, not the KMyMoney one", async ({
      authedPage: page,
    }) => {
      await page.goto("/import");
      await page.locator('input[type="file"]').setInputFiles({
        name: "statement.xml",
        mimeType: "text/xml",
        buffer: Buffer.from(OFX_XML),
      });

      // The OFX wizard asks where the statement goes; it never opens the
      // KMyMoney review or reports a KMyMoney refusal.
      await expect(
        page.getByRole("heading", { name: /select destination account/i }),
      ).toBeVisible({ timeout: PARSE_TIMEOUT });
      await expect(
        page.getByRole("heading", { name: /review your kmymoney file/i }),
      ).toHaveCount(0);
      await expect(
        page.getByText("That KMyMoney file could not be opened"),
      ).toHaveCount(0);
    });

    test("refuses an unrelated .xml, saying it is neither, and imports nothing", async ({
      authedPage: page,
    }) => {
      await page.goto("/import");
      await page.locator('input[type="file"]').setInputFiles({
        name: "logo.xml",
        mimeType: "text/xml",
        buffer: Buffer.from(
          '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        ),
      });

      await expect(
        page.getByText(/neither a KMyMoney file nor an OFX file/i),
      ).toBeVisible({ timeout: PARSE_TIMEOUT });
      await expect(page.getByText(/logo\.xml/)).toBeVisible();
      // No guess was made: still on the upload step, no KMyMoney panel.
      await expect(
        page.getByText(/upload transaction files/i).first(),
      ).toBeVisible();
      await expect(
        page.getByText("That KMyMoney file could not be opened"),
      ).toHaveCount(0);
    });
  });

  const refusals: ReadonlyArray<{
    title: string;
    name: string;
    buffer: Buffer;
    message: RegExp;
  }> = [
    {
      title: "a file that is not a KMyMoney file",
      name: "not-really.kmy",
      buffer: Buffer.alloc(8192, 0x41),
      message: /not a KMyMoney file/i,
    },
    {
      title: "a GPG-encrypted file",
      name: "secret.kmy",
      buffer: Buffer.from("-----BEGIN PGP MESSAGE-----\n".padEnd(8192, "x")),
      message: /encrypted/i,
    },
    {
      title: "a KMyMoney SQL database",
      name: "data.kmy",
      buffer: Buffer.concat([
        Buffer.from("SQLite format 3\0"),
        Buffer.alloc(8192, 0),
      ]),
      message: /Save As/i,
    },
    {
      title: "an anonymized file",
      name: "test.anon.xml",
      buffer: readFileSync(XML_SAMPLE),
      message: /anonymized/i,
    },
  ];

  for (const refusal of refusals) {
    test(`refuses ${refusal.title} with the KMyMoney message`, async ({
      authedPage: page,
    }) => {
      await page.goto("/import");
      await page.locator('input[type="file"]').setInputFiles({
        name: refusal.name,
        mimeType: "application/octet-stream",
        buffer: refusal.buffer,
      });

      await expect(
        page.getByText("That KMyMoney file could not be opened"),
      ).toBeVisible({ timeout: PARSE_TIMEOUT });
      await expect(page.getByText(refusal.message).first()).toBeVisible();
      // Money's password prompt is never borrowed.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText(/needs a password/i)).toHaveCount(0);
    });
  }
});
