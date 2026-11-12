/**
 * Demo shared expense groups. Every amount is in the group's currency, so a
 * row's group amount equals its original amount at an exchange rate of 1.
 * `payer` is who paid; `shares` are who owes what. Share and payer amounts
 * must each add up to the entry's amount (a deferred trigger enforces it).
 */
export interface DemoSharedEntry {
  type: "EXPENSE" | "REPAYMENT";
  title: string;
  note?: string;
  categoryLabel?: string;
  /** Days before today. */
  daysAgo: number;
  amount: number;
  splitMode?: "EQUAL" | "EXACT" | "PERCENT" | "WEIGHT";
  /** Who paid. For a REPAYMENT, who paid back. */
  payer: string;
  /** For a REPAYMENT, who received the money. */
  recipient?: string;
  /** Who shares an expense: a name, and the instruction for non-equal modes. */
  shares?: { name: string; amount: number; instruction?: string }[];
}

export interface DemoSharedGroup {
  name: string;
  description: string;
  currencyCode: string;
  /** The demo user's own name within the group. */
  myName: string;
  others: string[];
  entries: DemoSharedEntry[];
}

export const demoSharedGroups: DemoSharedGroup[] = [
  {
    name: "Whistler Ski Weekend",
    description: "Four of us, three nights in the village.",
    currencyCode: "CAD",
    myName: "Demo",
    others: ["Alex", "Jordan", "Sam"],
    entries: [
      {
        type: "EXPENSE",
        title: "Chalet rental",
        categoryLabel: "Lodging",
        daysAgo: 34,
        amount: 1680,
        payer: "Alex",
        shares: [
          { name: "Demo", amount: 420 },
          { name: "Alex", amount: 420 },
          { name: "Jordan", amount: 420 },
          { name: "Sam", amount: 420 },
        ],
      },
      {
        type: "EXPENSE",
        title: "Lift tickets",
        categoryLabel: "Activities",
        daysAgo: 33,
        amount: 1036,
        payer: "Demo",
        shares: [
          { name: "Demo", amount: 259 },
          { name: "Alex", amount: 259 },
          { name: "Jordan", amount: 259 },
          { name: "Sam", amount: 259 },
        ],
      },
      {
        type: "EXPENSE",
        title: "Groceries and drinks",
        categoryLabel: "Food",
        daysAgo: 33,
        amount: 312.47,
        payer: "Jordan",
        shares: [
          { name: "Demo", amount: 78.12 },
          { name: "Alex", amount: 78.12 },
          { name: "Jordan", amount: 78.12 },
          { name: "Sam", amount: 78.11 },
        ],
      },
      {
        type: "EXPENSE",
        title: "Dinner at the Rimrock",
        note: "Sam skipped dessert and drinks, so a smaller share.",
        categoryLabel: "Food",
        daysAgo: 32,
        amount: 268.5,
        splitMode: "EXACT",
        payer: "Demo",
        shares: [
          { name: "Demo", amount: 74, instruction: "74.00" },
          { name: "Alex", amount: 74, instruction: "74.00" },
          { name: "Jordan", amount: 74, instruction: "74.00" },
          { name: "Sam", amount: 46.5, instruction: "46.50" },
        ],
      },
      {
        type: "EXPENSE",
        title: "Gas and parking",
        categoryLabel: "Transport",
        daysAgo: 31,
        amount: 142.6,
        payer: "Sam",
        shares: [
          { name: "Demo", amount: 35.65 },
          { name: "Alex", amount: 35.65 },
          { name: "Jordan", amount: 35.65 },
          { name: "Sam", amount: 35.65 },
        ],
      },
      {
        type: "REPAYMENT",
        title: "Settled up e-transfer",
        daysAgo: 20,
        amount: 150,
        payer: "Jordan",
        recipient: "Demo",
      },
    ],
  },
  {
    name: "Apartment 4B",
    description: "Shared household bills with the roommates.",
    currencyCode: "CAD",
    myName: "Demo",
    others: ["Riley", "Morgan"],
    entries: [
      {
        type: "EXPENSE",
        title: "Internet (Rogers)",
        categoryLabel: "Utilities",
        daysAgo: 12,
        amount: 90,
        payer: "Demo",
        shares: [
          { name: "Demo", amount: 30 },
          { name: "Riley", amount: 30 },
          { name: "Morgan", amount: 30 },
        ],
      },
      {
        type: "EXPENSE",
        title: "Hydro bill",
        categoryLabel: "Utilities",
        daysAgo: 9,
        amount: 187.4,
        splitMode: "WEIGHT",
        note: "Weighted by days at home this month.",
        payer: "Riley",
        shares: [
          { name: "Demo", amount: 74.96, instruction: "4" },
          { name: "Riley", amount: 74.96, instruction: "4" },
          { name: "Morgan", amount: 37.48, instruction: "2" },
        ],
      },
      {
        type: "EXPENSE",
        title: "Cleaning supplies",
        categoryLabel: "Household",
        daysAgo: 6,
        amount: 64.2,
        payer: "Morgan",
        shares: [
          { name: "Demo", amount: 21.4 },
          { name: "Riley", amount: 21.4 },
          { name: "Morgan", amount: 21.4 },
        ],
      },
      {
        type: "EXPENSE",
        title: "New couch",
        categoryLabel: "Furniture",
        daysAgo: 3,
        amount: 1200,
        splitMode: "PERCENT",
        payer: "Demo",
        shares: [
          { name: "Demo", amount: 480, instruction: "40" },
          { name: "Riley", amount: 420, instruction: "35" },
          { name: "Morgan", amount: 300, instruction: "25" },
        ],
      },
      {
        type: "REPAYMENT",
        title: "Riley paid back",
        daysAgo: 2,
        amount: 100,
        payer: "Riley",
        recipient: "Demo",
      },
    ],
  },
];
