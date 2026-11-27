/**
 * The generic baseline category catalog offered to every new user.
 *
 * These names are deliberately country-neutral: nothing here assumes a
 * particular tax system, benefit programme, or currency. Country-specific
 * additions (tax lines, state benefits, local charges) live in
 * `country-category-additions.ts` and are merged over this baseline by
 * `getDefaultCategories()`.
 *
 * The English names are the source of truth for the i18n catalog -- see
 * `default-category-i18n.ts` for how each name maps to a translation key.
 * Parents and subcategories are kept alphabetically sorted so the merged
 * output is stable regardless of which country overlay is applied.
 */

export interface DefaultCategoryDefinition {
  name: string;
  subcategories: string[];
}

/** A complete catalog: the income, expense and transfer trees. */
export interface DefaultCategorySet {
  income: DefaultCategoryDefinition[];
  expense: DefaultCategoryDefinition[];
  transfer: DefaultCategoryDefinition[];
}

export const DEFAULT_INCOME_CATEGORIES: DefaultCategoryDefinition[] = [
  {
    name: "Investment Income",
    subcategories: ["Capital Gains", "Dividends", "Interest"],
  },
  {
    name: "Other Income",
    subcategories: [
      "Business Reimbursement",
      "Cashback",
      "Credit Card Reward",
      "Freelance",
      "Gifts Received",
      "Rental Income",
      "Tax Refund",
    ],
  },
  {
    name: "Retirement Income",
    subcategories: ["Annuity", "Pension", "Retirement Account Withdrawal"],
  },
  {
    name: "Wages & Salary",
    subcategories: [
      "Bonus",
      "Commission",
      "Employer Matching",
      "Gross Pay",
      "Net Pay",
      "Overtime",
      "Stock Options",
      "Tips",
      "Vacation Pay",
    ],
  },
];

export const DEFAULT_EXPENSE_CATEGORIES: DefaultCategoryDefinition[] = [
  {
    name: "Automobile",
    subcategories: [
      "Accessories",
      "Car Payment",
      "Cleaning",
      "Fines",
      "Fuel",
      "Maintenance",
      "Parking",
      "Parts",
      "Registration",
      "Tolls",
    ],
  },
  {
    name: "Bank Fees",
    subcategories: [
      "Annual Fee",
      "ATM",
      "Foreign Transaction",
      "Other",
      "Overdraft",
      "Service Charge",
    ],
  },
  {
    name: "Bills",
    subcategories: [
      "Electricity",
      "Internet",
      "Mobile Phone",
      "Natural Gas",
      "Streaming Services",
      "Telephone",
      "Television",
      "Waste Collection",
      "Water & Sewer",
    ],
  },
  {
    name: "Business",
    subcategories: [
      "Airfare",
      "Car Rental",
      "Dining Out",
      "Fuel",
      "Lodging",
      "Mileage",
      "Miscellaneous",
      "Mobile Phone",
      "Office Supplies",
      "Parking",
      "Software",
      "Transit",
    ],
  },
  { name: "Cash Withdrawal", subcategories: [] },
  { name: "Charitable Donations", subcategories: [] },
  {
    name: "Childcare",
    subcategories: [
      "Activities",
      "Allowance",
      "Babysitting",
      "Clothing",
      "Daycare",
      "School Supplies",
      "Sports",
      "Toys & Games",
    ],
  },
  {
    name: "Clothing",
    subcategories: ["Accessories", "Clothes", "Outerwear", "Shoes"],
  },
  {
    name: "Education",
    subcategories: ["Books", "Fees", "Supplies", "Tuition"],
  },
  {
    name: "Food",
    subcategories: [
      "Alcohol",
      "Coffee Shops",
      "Dining Out",
      "Groceries",
      "Takeout",
    ],
  },
  {
    name: "Furnishings",
    subcategories: [
      "Accessories",
      "Appliances",
      "Bathroom",
      "Bedroom",
      "Decor",
      "Dishes",
      "Kitchen",
      "Living Room",
      "Office",
      "Outdoor",
    ],
  },
  {
    name: "Gifts",
    subcategories: [
      "Anniversary",
      "Birthday",
      "Cards",
      "Flowers",
      "Holiday",
      "Wedding",
    ],
  },
  {
    name: "Government Fees",
    subcategories: ["Licences & Permits", "Passport"],
  },
  {
    name: "Healthcare",
    subcategories: [
      "Counselling",
      "Dental",
      "Eyecare",
      "Fitness",
      "Hospital",
      "Medication",
      "Physician",
      "Physiotherapy",
      "Supplies",
    ],
  },
  {
    name: "Housing",
    subcategories: [
      "Fees",
      "Garden",
      "Home Improvement",
      "Maintenance",
      "Mortgage Interest",
      "Mortgage Principal",
      "Rent",
      "Supplies",
      "Tools",
    ],
  },
  {
    name: "Insurance",
    subcategories: [
      "Automobile",
      "Disability",
      "Health",
      "Home",
      "Life",
      "Renter",
      "Travel",
    ],
  },
  { name: "Interest Expense", subcategories: [] },
  {
    name: "Leisure",
    subcategories: [
      "Books & Magazines",
      "Camping",
      "Concerts",
      "Cultural Events",
      "Electronics",
      "Games",
      "Hobbies",
      "Movies",
      "Music",
      "Sporting Events",
      "Sporting Goods",
      "Sports",
    ],
  },
  {
    name: "Loan",
    subcategories: ["Loan Interest", "Loan Principal"],
  },
  {
    name: "Miscellaneous",
    subcategories: ["Other", "Postage"],
  },
  {
    name: "Personal Care",
    subcategories: [
      "Cosmetics",
      "Dry Cleaning",
      "Haircut",
      "Laundry",
      "Spa",
      "Toiletries",
    ],
  },
  {
    name: "Pet Care",
    subcategories: ["Food", "Grooming", "Supplies", "Veterinarian"],
  },
  {
    name: "Professional Services",
    subcategories: ["Accounting", "Financial Advice", "Legal"],
  },
  {
    name: "Taxes",
    subcategories: ["Income Tax", "Other", "Property Tax", "Sales Tax"],
  },
  {
    name: "Technology",
    subcategories: ["Hardware", "Software", "Subscriptions", "Web Hosting"],
  },
  {
    name: "Transportation",
    subcategories: ["Bicycle", "Public Transit", "Rideshare", "Taxi"],
  },
  {
    name: "Vacation",
    subcategories: [
      "Activities",
      "Airfare",
      "Car Rental",
      "Fuel",
      "Lodging",
      "Miscellaneous",
      "Parking",
    ],
  },
];

/**
 * The short Transfer set a new user starts with: money moved between the
 * person's own accounts, which is neither income nor spending. It sits under one
 * parent so it groups in a picker; nothing requires a Transfer category to have
 * a parent. A Transfer category goes only on a transfer.
 */
export const DEFAULT_TRANSFER_CATEGORIES: DefaultCategoryDefinition[] = [
  {
    name: "Transfers",
    subcategories: [
      "Between Own Accounts",
      "Cash Withdrawals",
      "Credit Card Payments",
      "Investment Contributions",
      "Savings Contributions",
    ],
  },
];

/** The country-neutral catalog, used when no country is selected. */
export const GENERIC_CATEGORY_SET: DefaultCategorySet = {
  income: DEFAULT_INCOME_CATEGORIES,
  expense: DEFAULT_EXPENSE_CATEGORIES,
  transfer: DEFAULT_TRANSFER_CATEGORIES,
};
