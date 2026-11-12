export interface DemoWarrantyClaim {
  /** Days before today the claim was opened. */
  openedDaysAgo: number;
  status: "open" | "approved" | "denied" | "resolved";
  description: string;
  resolution?: string;
  /** Days after it was opened that it was resolved, when it has been. */
  resolvedAfterDays?: number;
}

export interface DemoWarranty {
  name: string;
  vendorName: string;
  /** A demo payee's name, linked when the demo has that payee. */
  payeeName?: string;
  modelNumber?: string;
  serialNumbers?: string[];
  kind: "manufacturer" | "extended" | "store" | "other";
  /** Whole months before today the item was bought. */
  purchasedMonthsAgo: number;
  /** Days from today the cover ends (negative = already expired). */
  expiresInDays?: number;
  isLifetime?: boolean;
  purchasePrice?: number;
  productUrl?: string;
  notes?: string;
  archived?: boolean;
  claims?: DemoWarrantyClaim[];
}

/**
 * Dates are relative to the day of the reset so the page always shows the full
 * range: one expiring this month, a few later in the year or beyond, one
 * lifetime, one already expired and one archived.
 */
export const demoWarranties: DemoWarranty[] = [
  {
    name: 'Samsung 65" QLED TV',
    vendorName: "Best Buy",
    payeeName: "Best Buy",
    modelNumber: "QN65Q80D",
    serialNumbers: ["0A3X4BKR100342M"],
    kind: "manufacturer",
    purchasedMonthsAgo: 11,
    expiresInDays: 24,
    purchasePrice: 1299.99,
    notes: "One year parts and labour. Panel flicker reported, claim open.",
    claims: [
      {
        openedDaysAgo: 6,
        status: "open",
        description: "Intermittent flicker at low brightness. Photos sent.",
      },
    ],
  },
  {
    name: 'MacBook Pro 14" M3',
    vendorName: "Apple",
    modelNumber: "MR7J3LL/A",
    serialNumbers: ["C02ZK1XYQ05D"],
    kind: "extended",
    purchasedMonthsAgo: 14,
    expiresInDays: 625,
    purchasePrice: 2399,
    productUrl: "https://www.apple.com/ca/applecare/",
    notes: "AppleCare+ with accidental damage cover.",
  },
  {
    name: "Dyson V15 Detect Vacuum",
    vendorName: "Costco",
    payeeName: "Costco",
    modelNumber: "SV47",
    serialNumbers: ["V15-88213046"],
    kind: "manufacturer",
    purchasedMonthsAgo: 5,
    expiresInDays: 575,
    purchasePrice: 799.99,
    notes: "Two year warranty. Costco adds a second year on top.",
  },
  {
    name: "Sony WH-1000XM5 Headphones",
    vendorName: "Best Buy",
    payeeName: "Best Buy",
    modelNumber: "WH1000XM5/B",
    kind: "store",
    purchasedMonthsAgo: 11,
    expiresInDays: 19,
    purchasePrice: 449.99,
    claims: [
      {
        openedDaysAgo: 40,
        status: "approved",
        description: "Left ear cup crackles at high volume.",
        resolution: "Replacement unit approved and shipped.",
        resolvedAfterDays: 12,
      },
    ],
  },
  {
    name: "Bosch 500 Series Dishwasher",
    vendorName: "Home Depot",
    payeeName: "Home Depot",
    modelNumber: "SHEM63W55N",
    serialNumbers: ["FD 9604 013812"],
    kind: "manufacturer",
    purchasedMonthsAgo: 17,
    expiresInDays: -150,
    purchasePrice: 949,
    notes: "Expired. The drain pump claim was covered while in warranty.",
    claims: [
      {
        openedDaysAgo: 330,
        status: "resolved",
        description: "Drain pump stopped working.",
        resolution: "Technician replaced the pump at no charge.",
        resolvedAfterDays: 21,
      },
      {
        openedDaysAgo: 200,
        status: "denied",
        description: "Cosmetic scratch on the door panel.",
        resolution: "Denied: cosmetic damage is not covered.",
        resolvedAfterDays: 9,
      },
    ],
  },
  {
    name: "Craftsman 230-Piece Mechanic's Tool Set",
    vendorName: "Canadian Tire",
    payeeName: "Canadian Tire Auto",
    kind: "other",
    purchasedMonthsAgo: 30,
    isLifetime: true,
    purchasePrice: 249.99,
    notes: "Lifetime hand tool warranty. Bring the broken tool to any store.",
  },
  {
    name: "Michelin X-Ice Winter Tires",
    vendorName: "Canadian Tire",
    payeeName: "Canadian Tire Auto",
    kind: "other",
    purchasedMonthsAgo: 26,
    expiresInDays: -20,
    purchasePrice: 1120,
    notes: "Archived: sold with the old car.",
    archived: true,
  },
];
