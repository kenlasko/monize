export interface DemoScheduledTransaction {
  name: string;
  accountKey: string;
  payeeName: string;
  categoryPath: string;
  amount: number;
  frequency: string;
  dueDayOfMonth: number;
  autoPost: boolean;
  isTransfer?: boolean;
  transferAccountKey?: string;
}

export const demoScheduledTransactions: DemoScheduledTransaction[] = [
  {
    name: "Salary",
    accountKey: "chequing",
    payeeName: "Maple Leaf Technologies",
    categoryPath: "Salary",
    amount: 2250.0,
    frequency: "BIWEEKLY",
    dueDayOfMonth: 15,
    autoPost: true,
  },
  {
    name: "Mortgage Payment",
    accountKey: "chequing",
    payeeName: "Scotiabank Mortgage",
    categoryPath: "Housing > Rent/Mortgage",
    amount: -2100.0,
    frequency: "MONTHLY",
    dueDayOfMonth: 1,
    autoPost: true,
  },
  {
    name: "Hydro Bill",
    accountKey: "chequing",
    payeeName: "Hydro One",
    categoryPath: "Bills & Utilities > Electricity",
    amount: -120.0,
    frequency: "MONTHLY",
    dueDayOfMonth: 12,
    autoPost: false,
  },
  {
    name: "Internet",
    accountKey: "chequing",
    payeeName: "Rogers Internet",
    categoryPath: "Bills & Utilities > Internet",
    amount: -79.99,
    frequency: "MONTHLY",
    dueDayOfMonth: 14,
    autoPost: true,
  },
  {
    name: "Phone",
    accountKey: "chequing",
    payeeName: "Bell Canada",
    categoryPath: "Bills & Utilities > Phone",
    amount: -65.0,
    frequency: "MONTHLY",
    dueDayOfMonth: 20,
    autoPost: true,
  },
  {
    name: "Netflix",
    accountKey: "visa",
    payeeName: "Netflix",
    categoryPath: "Entertainment > Streaming Services",
    amount: -22.99,
    frequency: "MONTHLY",
    dueDayOfMonth: 18,
    autoPost: true,
  },
  {
    name: "Gym Membership",
    accountKey: "chequing",
    payeeName: "GoodLife Fitness",
    categoryPath: "Health > Gym",
    amount: -49.99,
    frequency: "MONTHLY",
    dueDayOfMonth: 1,
    autoPost: true,
  },
  {
    name: "Emergency Fund Transfer",
    accountKey: "chequing",
    payeeName: "Transfer",
    categoryPath: "Salary",
    amount: -500.0,
    frequency: "MONTHLY",
    dueDayOfMonth: 16,
    autoPost: true,
    isTransfer: true,
    transferAccountKey: "savings",
  },
  {
    name: "Car Insurance",
    accountKey: "chequing",
    payeeName: "Aviva Insurance",
    categoryPath: "Transportation > Car Insurance",
    amount: -185.0,
    frequency: "MONTHLY",
    dueDayOfMonth: 5,
    autoPost: false,
  },
  {
    name: "Spotify",
    accountKey: "visa",
    payeeName: "Spotify",
    categoryPath: "Entertainment > Streaming Services",
    amount: -11.99,
    frequency: "MONTHLY",
    dueDayOfMonth: 5,
    autoPost: true,
  },
];
