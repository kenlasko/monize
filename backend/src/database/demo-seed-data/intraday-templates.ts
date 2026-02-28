export interface IntradayTemplate {
  payeeName: string;
  categoryPath: string;
  minAmount: number;
  maxAmount: number;
  accountKey: "chequing" | "visa" | "mastercard";
  description: string;
}

export const INTRADAY_TEMPLATES: IntradayTemplate[] = [
  {
    payeeName: "Tim Hortons",
    categoryPath: "Food > Coffee Shops",
    minAmount: 2.5,
    maxAmount: 6.5,
    accountKey: "visa",
    description: "Coffee",
  },
  {
    payeeName: "Starbucks",
    categoryPath: "Food > Coffee Shops",
    minAmount: 5.5,
    maxAmount: 8.5,
    accountKey: "visa",
    description: "Coffee",
  },
  {
    payeeName: "Uber Eats",
    categoryPath: "Food > Restaurants",
    minAmount: 18.0,
    maxAmount: 45.0,
    accountKey: "visa",
    description: "Takeout / delivery",
  },
  {
    payeeName: "Swiss Chalet",
    categoryPath: "Food > Restaurants",
    minAmount: 25.0,
    maxAmount: 55.0,
    accountKey: "mastercard",
    description: "Lunch",
  },
  {
    payeeName: "TTC",
    categoryPath: "Transportation > Public Transit",
    minAmount: 3.35,
    maxAmount: 3.35,
    accountKey: "chequing",
    description: "Transit fare",
  },
  {
    payeeName: "Shoppers Drug Mart",
    categoryPath: "Health > Pharmacy",
    minAmount: 8.0,
    maxAmount: 25.0,
    accountKey: "visa",
    description: "Pharmacy",
  },
  {
    payeeName: "Loblaws",
    categoryPath: "Food > Groceries",
    minAmount: 15.0,
    maxAmount: 55.0,
    accountKey: "visa",
    description: "Quick groceries",
  },
  {
    payeeName: "No Frills",
    categoryPath: "Food > Groceries",
    minAmount: 12.0,
    maxAmount: 40.0,
    accountKey: "chequing",
    description: "Groceries",
  },
  {
    payeeName: "Amazon.ca",
    categoryPath: "Shopping > Electronics",
    minAmount: 15.0,
    maxAmount: 60.0,
    accountKey: "visa",
    description: "Online purchase",
  },
  {
    payeeName: "Shell",
    categoryPath: "Transportation > Fuel",
    minAmount: 40.0,
    maxAmount: 75.0,
    accountKey: "visa",
    description: "Gas fill-up",
  },
];
