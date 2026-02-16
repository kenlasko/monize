export interface DemoPayee {
  name: string;
  categoryPath: string; // "Parent > Subcategory" or just "Category"
}

export const demoPayees: DemoPayee[] = [
  // Income
  { name: "Maple Leaf Technologies", categoryPath: "Salary" },
  { name: "Freelance Client - WebDev", categoryPath: "Freelance" },

  // Housing
  { name: "Scotiabank Mortgage", categoryPath: "Housing > Rent/Mortgage" },
  { name: "Hydro One", categoryPath: "Bills & Utilities > Electricity" },
  { name: "Enbridge Gas", categoryPath: "Bills & Utilities > Insurance" },
  { name: "Toronto Water", categoryPath: "Bills & Utilities > Water" },

  // Transport
  { name: "Shell", categoryPath: "Transportation > Fuel" },
  { name: "Esso", categoryPath: "Transportation > Fuel" },
  { name: "TTC", categoryPath: "Transportation > Public Transit" },
  { name: "Canadian Tire Auto", categoryPath: "Transportation > Maintenance" },
  { name: "Aviva Insurance", categoryPath: "Transportation > Car Insurance" },

  // Food & Dining
  { name: "Loblaws", categoryPath: "Food > Groceries" },
  { name: "No Frills", categoryPath: "Food > Groceries" },
  { name: "Metro", categoryPath: "Food > Groceries" },
  { name: "Costco", categoryPath: "Food > Groceries" },
  { name: "Tim Hortons", categoryPath: "Food > Coffee Shops" },
  { name: "Starbucks", categoryPath: "Food > Coffee Shops" },
  { name: "Swiss Chalet", categoryPath: "Food > Restaurants" },
  { name: "Uber Eats", categoryPath: "Food > Restaurants" },
  { name: "The Keg Steakhouse", categoryPath: "Food > Restaurants" },

  // Shopping
  { name: "Amazon.ca", categoryPath: "Shopping > Electronics" },
  { name: "Best Buy", categoryPath: "Shopping > Electronics" },
  { name: "IKEA", categoryPath: "Shopping > Home Goods" },
  { name: "Winners", categoryPath: "Shopping > Clothing" },

  // Bills & Subscriptions
  { name: "Bell Canada", categoryPath: "Bills & Utilities > Phone" },
  { name: "Rogers Internet", categoryPath: "Bills & Utilities > Internet" },
  { name: "Netflix", categoryPath: "Entertainment > Streaming Services" },
  { name: "Spotify", categoryPath: "Entertainment > Streaming Services" },
  { name: "Disney+", categoryPath: "Entertainment > Streaming Services" },

  // Health
  { name: "Shoppers Drug Mart", categoryPath: "Health > Pharmacy" },
  { name: "GoodLife Fitness", categoryPath: "Health > Gym" },
  { name: "Dr. Smith", categoryPath: "Health > Doctor Visits" },

  // Other
  { name: "Cineplex", categoryPath: "Entertainment > Movies" },
  { name: "Air Canada", categoryPath: "Travel" },
  { name: "Airbnb", categoryPath: "Travel" },
];
