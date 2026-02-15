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
}

const incomeCategories: CategoryDef[] = [
  {
    parent: "Investment Income",
    children: ["Capital Gains", "Interest", "RESP Grant"],
  },
  {
    parent: "Other Income",
    children: [
      "Blogging",
      "Business Reimbursement",
      "Cashback",
      "Consulting",
      "Credit Card Reward",
      "Employee Stock Option",
      "Gifts Received",
      "Income Tax Refund",
      "Rental Income",
      "State & Local Tax Refund",
      "Transfer Bonus",
      "Tutoring",
    ],
  },
  { parent: "Retirement Income", children: ["CPP/QPP Benefits"] },
  {
    parent: "Wages & Salary",
    children: [
      "Bonus",
      "Commission",
      "Employer Matching",
      "Gross Pay",
      "Net Pay",
      "Overtime",
      "Vacation Pay",
    ],
  },
];

async function addIncomeCategories() {
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
    console.log(`\nAdding income categories for user: ${userId}`);

    let parentCount = 0;
    let childCount = 0;

    for (const catDef of incomeCategories) {
      // Check if parent category already exists
      const existingParent = await dataSource.query(
        "SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id IS NULL",
        [userId, catDef.parent],
      );

      let parentId: string;

      if (existingParent.length > 0) {
        parentId = existingParent[0].id;
        // Update to income if not already
        await dataSource.query(
          "UPDATE categories SET is_income = true WHERE id = $1",
          [parentId],
        );
        console.log(
          `  Parent "${catDef.parent}" already exists, marked as income`,
        );
      } else {
        // Create parent category as income
        const result = await dataSource.query(
          `INSERT INTO categories (user_id, name, is_income)
           VALUES ($1, $2, true)
           RETURNING id`,
          [userId, catDef.parent],
        );
        parentId = result[0].id;
        parentCount++;
        console.log(`  Created income parent: ${catDef.parent}`);
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
             VALUES ($1, $2, $3, true)`,
            [userId, parentId, childName],
          );
          childCount++;
        } else {
          // Update to income if not already
          await dataSource.query(
            "UPDATE categories SET is_income = true WHERE id = $1",
            [existingChild[0].id],
          );
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

addIncomeCategories().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
