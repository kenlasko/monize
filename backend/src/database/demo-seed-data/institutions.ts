export interface DemoInstitution {
  /** Must match the `institution` name used on demo accounts (accounts.ts). */
  name: string;
  website: string;
  country: string;
}

/**
 * Institutions referenced by the demo accounts. Seeding these (and linking
 * accounts via institution_id) lets the demo show institution names and brand
 * logos, and populates the Institutions page.
 */
export const demoInstitutions: DemoInstitution[] = [
  { name: "TD Canada Trust", website: "https://www.td.com", country: "CA" },
  { name: "EQ Bank", website: "https://www.eqbank.ca", country: "CA" },
  { name: "CIBC", website: "https://www.cibc.com", country: "CA" },
  { name: "Scotiabank", website: "https://www.scotiabank.com", country: "CA" },
  { name: "Questrade", website: "https://www.questrade.com", country: "CA" },
];
