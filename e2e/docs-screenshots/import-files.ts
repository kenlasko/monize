import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { open } from "../readme/session";

// What the import pages' captures share: the sample files they upload, and
// the steps that get the wizard to a state. Every capture stops at the review
// step and leaves; nothing is ever imported into the demo data.

/** The real Microsoft Money files the backend's own specs read. */
export const MNY_FIXTURES = join(
  __dirname,
  "../../backend/src/import/mny/__fixtures__",
);

/** A bank's CSV download for the demo's Primary Chequing. */
export const CHEQUING_CSV = [
  "Date,Description,Category,Amount,Memo,Reference",
  "2026-10-02,LOBLAWS #1043,Food:Groceries,-84.12,,",
  "2026-10-05,PAYROLL DEPOSIT,Salary,2450.00,October pay,",
  "2026-10-06,PETSMART #88,Pets,-42.30,Dog food,",
  "2026-10-08,TRANSFER TO SAVINGS,Transfer,-500.00,,",
  "2026-10-15,CAR LOAN PAYMENT,Car Loan,-385.00,,",
  "2026-10-18,CHEQUE 1042,Home Repairs,-250.00,Plumber,1042",
].join("\n");

/** A one-account Quicken QIF export with a transfer and colon categories. */
export function bankQif(transfer = "Vacation Fund"): string {
  return [
    "!Type:Bank",
    "D10/ 2/26",
    "T-84.12",
    "PLoblaws",
    "LFood:Groceries",
    "^",
    "D10/ 5/26",
    "T2,450.00",
    "PAcme Corp",
    "LSalary",
    "C*",
    "^",
    "D10/ 9/26",
    "T-61.80",
    "PShell",
    "LAuto:Fuel",
    "^",
    "D10/12/26",
    "T-38.00",
    "PCity Parking",
    "LAuto:Parking",
    "^",
    "D10/20/26",
    "T-300.00",
    "PSavings transfer",
    `L[${transfer}]`,
    "^",
    "",
  ].join("\n");
}

/** An investment account's QIF export: one known security, two new ones. */
export const INVESTMENT_QIF = [
  "!Type:Invst",
  "D10/01/2026",
  "NBuy",
  "YVOO",
  "I512.40",
  "Q4",
  "T2049.60",
  "^",
  "D10/06/2026",
  "NBuy",
  "YCanadian National Railway",
  "I168.25",
  "Q10",
  "T1682.50",
  "^",
  "D10/15/2026",
  "NDiv",
  "YVOO",
  "T18.20",
  "^",
  "D10/20/2026",
  "NBuy",
  "YShopify Inc.",
  "I141.10",
  "Q5",
  "T705.50",
  "^",
  "",
].join("\n");

/** A Quicken "all accounts" export: categories, tags and three accounts in one file. */
export const FULL_FILE_QIF = [
  "!Type:Tag",
  "NVacation",
  "DTrips and holidays",
  "^",
  "NReimbursable",
  "^",
  "!Type:Cat",
  "NFood",
  "DFood and dining",
  "E",
  "^",
  "NFood:Groceries",
  "E",
  "^",
  "NFood:Restaurants",
  "E",
  "^",
  "NAuto",
  "E",
  "^",
  "NAuto:Fuel",
  "E",
  "^",
  "NSalary",
  "I",
  "^",
  "!Account",
  "NJoint Chequing",
  "TBank",
  "^",
  "!Type:Bank",
  "D10/ 1/26",
  "T2,450.00",
  "PAcme Corp",
  "LSalary",
  "C*",
  "^",
  "D10/ 4/26",
  "T-84.12",
  "PLoblaws",
  "LFood:Groceries",
  "^",
  "D10/ 9/26",
  "T-600.00",
  "PRewards Visa Payment",
  "L[Rewards Visa]",
  "^",
  "!Account",
  "NRewards Visa",
  "TCCard",
  "^",
  "!Type:CCard",
  "D10/ 3/26",
  "T-61.80",
  "PShell",
  "LAuto:Fuel",
  "^",
  "D10/ 7/26",
  "T-142.35",
  "PThe Keg",
  "LFood:Restaurants/Vacation",
  "^",
  "D10/ 9/26",
  "T600.00",
  "PPayment - Thank You",
  "L[Joint Chequing]",
  "^",
  "!Account",
  "NHouse",
  "TOth A",
  "^",
  "!Type:Oth A",
  "D10/ 1/26",
  "T0.00",
  "POpening Balance",
  "L[House]",
  "^",
  "",
].join("\n");

export interface UploadFile {
  name: string;
  content: string;
}

/** The Import page, on its upload step. */
export async function openImport(page: Page): Promise<void> {
  // The wizard matches a file against the accounts, categories and securities
  // it loads on arrival; a file handed over before they are in matches nothing.
  const loaded = [
    "/api/v1/accounts",
    "/api/v1/categories",
    "/api/v1/securities",
    "/api/v1/import/column-mappings",
  ].map((path) =>
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === path && r.request().method() === "GET",
      { timeout: 90_000 },
    ),
  );
  await open(page, "/import");
  await Promise.all(loaded);
  await expect(
    page.getByRole("heading", { name: "Upload Transaction Files" }),
  ).toBeVisible({
    timeout: 60_000,
  });
}

/** Hand the wizard files as if picked in the file dialog. */
export async function upload(page: Page, files: UploadFile[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: f.name.endsWith(".csv")
        ? "text/csv"
        : "application/octet-stream",
      buffer: Buffer.from(f.content),
    })),
  );
}

/** The card a wizard step is drawn in, found by its heading. */
export function stepCard(page: Page, heading: string): Locator {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " shadow ")][1]',
    );
}

/** The wizard's own Next button (the dev build adds a "Next.js" one). */
export function nextButton(page: Page): Locator {
  return page
    .getByRole("main")
    .getByRole("button", { name: "Next", exact: true });
}

/**
 * A select in the CSV mapping step, by the label above it. Those labels are
 * not tied to their selects, so the select is the label's next sibling.
 */
export function fieldSelect(page: Page, label: string): Locator {
  return page
    .getByRole("main")
    .locator("label")
    .filter({
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    })
    .locator("xpath=following-sibling::select[1]");
}

/** Leave the wizard without importing, so the next capture starts clean. */
export async function leaveWizard(page: Page): Promise<void> {
  await page.goto("/dashboard");
}
