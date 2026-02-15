import { DataSource } from "typeorm";
import * as dotenv from "dotenv";

dotenv.config();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const dataSource = new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: parseInt(process.env.DATABASE_PORT || "5432"),
  username: requiredEnv("DATABASE_USER"),
  password: requiredEnv("DATABASE_PASSWORD"),
  database: requiredEnv("DATABASE_NAME"),
});

interface CategoryDef {
  parent: string;
  children: string[];
  isIncome?: boolean;
}

const categories: CategoryDef[] = [
  {
    parent: "Automobile",
    children: [
      "Accessories",
      "Car Payment",
      "Cleaning",
      "Fines",
      "Gasoline",
      "Licensing",
      "Maintenance",
      "Parking",
      "Parts",
      "Toll Charges",
    ],
  },
  {
    parent: "Bank Fees",
    children: ["ATM", "Annual Fees", "NSF", "Other", "Overdraft", "Service"],
  },
  {
    parent: "Bills",
    children: [
      "Accounting",
      "Cable TV",
      "Cell Phone",
      "Electricity",
      "Internet",
      "Lawyer",
      "Membership Fees",
      "Natural Gas",
      "Satellite Radio",
      "Streaming",
      "Telephone",
      "Water & Sewer",
      "Water Heater",
    ],
  },
  {
    parent: "Business",
    children: [
      "Airfare",
      "Alcohol",
      "Bank Fees",
      "Car Rental",
      "Cell Phone",
      "Computer Software",
      "Computer Hardware",
      "Dining Out",
      "Education",
      "Internet",
      "Lodging",
      "Mileage",
      "Miscellaneous",
      "Parking",
      "Recreation",
      "Toll Charges",
      "Transit",
    ],
  },
  {
    parent: "Cash Withdrawal",
    children: [
      "Barbadian Dollars",
      "Bermudian Dollars",
      "Canadian Dollars",
      "Costa Rica Colones",
      "Dominican Republic Pesos",
      "Eastern Caribbean Dollars",
      "Euros",
      "Forints",
      "Honduran Lempiras",
      "Hong Kong Dollars",
      "Indonesian Rupiah",
      "Malaysian Ringgits",
      "Mexican Pesos",
      "Peruvian Soles",
      "Singapore Dollars",
      "Thai Baht",
      "US Dollars",
    ],
  },
  {
    parent: "Childcare",
    children: [
      "Activities",
      "Allowance",
      "Babysitting",
      "Books",
      "Clothing",
      "Counselling",
      "Daycare",
      "Entertainment",
      "Fees",
      "Furnishings",
      "Gifts",
      "Haircut",
      "Medication",
      "Shoes",
      "Sporting Goods",
      "Sports",
      "Supplies",
      "Toiletries",
      "Toys & Games",
    ],
  },
  {
    parent: "Clothing",
    children: ["Accessories", "Clothes", "Coats", "Shoes"],
  },
  { parent: "Computer", children: ["Hardware", "Software", "Web Hosting"] },
  { parent: "Education", children: ["Books", "Fees", "Tuition"] },
  {
    parent: "Food",
    children: ["Alcohol", "Cannabis", "Dining Out", "Groceries"],
  },
  {
    parent: "Furnishings",
    children: [
      "Accessories",
      "Appliances",
      "Basement",
      "Bathroom",
      "Bedroom",
      "Dining Room",
      "Dishes",
      "Kitchen",
      "Living Room",
      "Office",
      "Outdoor",
      "Plants",
    ],
  },
  {
    parent: "Gifts",
    children: [
      "Anniversary",
      "Birthday",
      "Cards",
      "Christmas",
      "Flowers",
      "Mother's Day",
      "RESP Contribution",
      "Valentines",
      "Wedding",
    ],
  },
  {
    parent: "Healthcare",
    children: [
      "Counselling",
      "Dental",
      "Eyecare",
      "Fertility",
      "Fitness",
      "Hospital",
      "Massage",
      "Medication",
      "Physician",
      "Physiotherapy",
      "Prescriptions",
      "Supplies",
    ],
  },
  {
    parent: "Housing",
    children: [
      "Fees",
      "Garden Supplies",
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
    parent: "Insurance",
    children: [
      "Automobile",
      "Disability",
      "Health",
      "Homeowner's/Renter's",
      "Life",
      "Travel",
    ],
  },
  { parent: "Interest Expense", children: [] },
  {
    parent: "Leisure",
    children: [
      "Books & Magazines",
      "Camera/Film",
      "Camping",
      "CD",
      "Cover Charge",
      "Cultural Events",
      "DVD",
      "Electronics",
      "Entertaining",
      "Entertainment",
      "Fees",
      "Gambling",
      "LPs",
      "Movies",
      "Newspaper",
      "Sporting Events",
      "Sporting Goods",
      "Sports",
      "Toys & Games",
      "Transit",
      "VHS",
      "Video Rentals",
    ],
  },
  {
    parent: "Loan",
    children: ["Loan Interest", "Loan Principal", "Mortgage Interest"],
  },
  {
    parent: "Miscellaneous",
    children: ["Postage", "Postcards", "Stamps", "Tools", "Transit"],
  },
  {
    parent: "Personal Care",
    children: ["Dry Cleaning", "Haircut", "Laundry", "Pedicure", "Toiletries"],
  },
  { parent: "Pet Care", children: ["Food", "Supplies", "Veterinarian"] },
  {
    parent: "Taxes",
    children: [
      "CPP/QPP Contributions",
      "EI Premiums",
      "Federal Income",
      "Goods & Services",
      "Other",
      "Property",
      "Real Estate",
      "State/Provincial",
      "Union Dues",
    ],
  },
  {
    parent: "Vacation",
    children: [
      "Airfare",
      "Car Rental",
      "Entertainment",
      "Gasoline",
      "Lodging",
      "Miscellaneous",
      "Parking",
      "Transit",
    ],
  },
];

async function addDefaultCategories() {
  await dataSource.initialize();
  console.log("Connected to database");

  // Get all users
  const users = await dataSource.query("SELECT id FROM users");

  if (users.length === 0) {
    console.log("No users found in database");
    await dataSource.destroy();
    return;
  }

  for (const user of users) {
    const userId = user.id;
    console.log(`\nAdding categories for user: ${userId}`);

    let parentCount = 0;
    let childCount = 0;

    for (const catDef of categories) {
      // Check if parent category already exists
      const existingParent = await dataSource.query(
        "SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id IS NULL",
        [userId, catDef.parent],
      );

      let parentId: string;

      if (existingParent.length > 0) {
        parentId = existingParent[0].id;
        console.log(`  Parent "${catDef.parent}" already exists`);
      } else {
        // Create parent category
        const result = await dataSource.query(
          `INSERT INTO categories (user_id, name, is_income)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, catDef.parent, catDef.isIncome || false],
        );
        parentId = result[0].id;
        parentCount++;
        console.log(`  Created parent: ${catDef.parent}`);
      }

      // Create child categories
      for (const childName of catDef.children) {
        // Check if child already exists
        const existingChild = await dataSource.query(
          "SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id = $3",
          [userId, childName, parentId],
        );

        if (existingChild.length === 0) {
          await dataSource.query(
            `INSERT INTO categories (user_id, parent_id, name, is_income)
             VALUES ($1, $2, $3, $4)`,
            [userId, parentId, childName, catDef.isIncome || false],
          );
          childCount++;
        }
      }
    }

    console.log(
      `  Added ${parentCount} parent categories and ${childCount} child categories`,
    );
  }

  await dataSource.destroy();
  console.log("\nDone!");
}

addDefaultCategories().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
