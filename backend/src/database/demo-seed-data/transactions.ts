import { demoAccounts } from "./accounts";
import { getPeriodicRate } from "../../accounts/mortgage-amortization.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../../accounts/payment-frequency.util";
import { roundToDecimals } from "../../common/round.util";

export interface DemoTransaction {
  accountKey: string;
  date: string;
  payeeName: string;
  categoryPath: string;
  amount: number;
  description: string;
  status: string;
  currencyCode?: string;
  // For split transactions. A split with `transferAccountKey` is a transfer
  // leg into that account (no category), the way a scheduled loan payment
  // posts its principal.
  isSplit?: boolean;
  splits?: DemoSplit[];
  // For transfers
  isTransfer?: boolean;
  transferAccountKey?: string;
  /**
   * What arrived on the other side of a cross-currency transfer, unsigned and
   * in the target account's currency (the API's `toAmount`). Absent for a
   * same-currency transfer, whose counterpart moves the same amount.
   */
  transferToAmount?: number;
}

export interface DemoSplit {
  categoryPath?: string;
  transferAccountKey?: string;
  amount: number;
  memo: string;
  /**
   * What a cross-currency transfer line delivered, unsigned and in the target
   * account's currency (the API's `transferTargetAmount`, INV-SPLITFX-001).
   */
  transferTargetAmount?: number;
}

/** Seeded random number generator for consistent results */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function randomBetween(rand: () => number, min: number, max: number): number {
  return Math.round((min + rand() * (max - min)) * 100) / 100;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getMonthDate(year: number, month: number, day: number): Date {
  // Clamp day to last day of month
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

/**
 * Generate 12 months of realistic transactions ending at referenceDate.
 * Returns ~400-500 transactions with realistic patterns.
 */
export function generateTransactions(referenceDate: Date): DemoTransaction[] {
  const transactions: DemoTransaction[] = [];
  const rand = seededRandom(42);

  const startDate = new Date(referenceDate);
  startDate.setMonth(startDate.getMonth() - 12);

  // The mortgage's debt before each installment, from its opening balance.
  const mortgage = demoAccounts.find((a) => a.key === "mortgage")!;
  const MORTGAGE_PAYMENT = mortgage.paymentAmount!;
  const mortgageRate = getPeriodicRate(
    mortgage.interestRate!,
    periodsPerYearForStoredFrequency(mortgage.paymentFrequency!) ??
      DEFAULT_PERIODS_PER_YEAR,
    mortgage.mortgageType!,
  );
  let mortgageDebt = Math.abs(mortgage.openingBalance);

  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth();

  for (let i = 0; i < 12; i++) {
    const year = startYear + Math.floor((startMonth + i) / 12);
    const month = (startMonth + i) % 12;
    const monthDate = new Date(year, month, 1);
    const isOlderThan2Months =
      monthDate <
      new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 2, 1);
    const isCurrentMonth =
      year === referenceDate.getFullYear() &&
      month === referenceDate.getMonth();

    const clearedStatus = isOlderThan2Months
      ? { status: "RECONCILED" }
      : isCurrentMonth
        ? { status: "UNRECONCILED" }
        : { status: "CLEARED" };

    // === SALARY (biweekly: 15th and last day) ===
    const salary15 = getMonthDate(year, month, 15);
    if (salary15 <= referenceDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(salary15),
        payeeName: "Maple Leaf Technologies",
        categoryPath: "Salary",
        amount: 2250.0,
        description: "Biweekly salary deposit",
        ...clearedStatus,
      });
    }
    const salaryEnd = getMonthDate(year, month, 28);
    if (salaryEnd <= referenceDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(salaryEnd),
        payeeName: "Maple Leaf Technologies",
        categoryPath: "Salary",
        amount: 2250.0,
        description: "Biweekly salary deposit",
        ...clearedStatus,
      });
    }

    // === MORTGAGE ===
    // The installment posts the way a scheduled mortgage payment does: one
    // chequing split, the principal a transfer leg into the mortgage and the
    // interest a category leg, the interest charged on the debt the ledger
    // carries before the payment at the mortgage's own periodic rate. The
    // mortgage-type detector reads it back as CANADIAN_FIXED
    // (docs/specs/mortgage-types.md, section 10).
    const mortgageDate = getMonthDate(year, month, 1);
    if (mortgageDate <= referenceDate && mortgageDate >= startDate) {
      const interest = roundToDecimals(mortgageDebt * mortgageRate, 2);
      const principal = roundToDecimals(MORTGAGE_PAYMENT - interest, 2);
      mortgageDebt = roundToDecimals(mortgageDebt - principal, 2);
      transactions.push({
        accountKey: "chequing",
        date: formatDate(mortgageDate),
        payeeName: "Scotiabank Mortgage",
        // Not written for a split parent: only its legs carry categories.
        categoryPath: "Housing > Mortgage Interest",
        amount: -MORTGAGE_PAYMENT,
        description: "Monthly mortgage payment",
        isSplit: true,
        splits: [
          {
            transferAccountKey: "mortgage",
            amount: -principal,
            memo: "Principal",
          },
          {
            categoryPath: "Housing > Mortgage Interest",
            amount: -interest,
            memo: "Interest",
          },
        ],
        ...clearedStatus,
      });
    }

    // === UTILITIES ===
    // Hydro (seasonal variation)
    const hydroDate = getMonthDate(year, month, 12);
    if (hydroDate <= referenceDate && hydroDate >= startDate) {
      const isWinter = month >= 10 || month <= 2;
      const isSummer = month >= 5 && month <= 8;
      const hydroBase = isWinter ? 140 : isSummer ? 95 : 110;
      transactions.push({
        accountKey: "chequing",
        date: formatDate(hydroDate),
        payeeName: "Hydro One",
        categoryPath: "Bills & Utilities > Electricity",
        amount: -randomBetween(rand, hydroBase - 15, hydroBase + 15),
        description: "Monthly electricity",
        ...clearedStatus,
      });
    }

    // Internet
    const internetDate = getMonthDate(year, month, 14);
    if (internetDate <= referenceDate && internetDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(internetDate),
        payeeName: "Rogers Internet",
        categoryPath: "Bills & Utilities > Internet",
        amount: -79.99,
        description: "Monthly internet",
        ...clearedStatus,
      });
    }

    // Phone
    const phoneDate = getMonthDate(year, month, 20);
    if (phoneDate <= referenceDate && phoneDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(phoneDate),
        payeeName: "Bell Canada",
        categoryPath: "Bills & Utilities > Phone",
        amount: -65.0,
        description: "Monthly phone plan",
        ...clearedStatus,
      });
    }

    // Gas (heating, seasonal)
    const gasDate = getMonthDate(year, month, 18);
    if (gasDate <= referenceDate && gasDate >= startDate) {
      const isHeating = month >= 9 || month <= 3;
      const gasAmount = isHeating
        ? randomBetween(rand, 85, 160)
        : randomBetween(rand, 25, 45);
      transactions.push({
        accountKey: "chequing",
        date: formatDate(gasDate),
        payeeName: "Enbridge Gas",
        categoryPath: "Bills & Utilities > Insurance",
        amount: -gasAmount,
        description: "Natural gas",
        ...clearedStatus,
      });
    }

    // Water
    const waterDate = getMonthDate(year, month, 22);
    if (waterDate <= referenceDate && waterDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(waterDate),
        payeeName: "Toronto Water",
        categoryPath: "Bills & Utilities > Water",
        amount: -randomBetween(rand, 40, 65),
        description: "Water & sewer",
        ...clearedStatus,
      });
    }

    // === SUBSCRIPTIONS (credit card) ===
    const netflixDate = getMonthDate(year, month, 18);
    if (netflixDate <= referenceDate && netflixDate >= startDate) {
      transactions.push({
        accountKey: "visa",
        date: formatDate(netflixDate),
        payeeName: "Netflix",
        categoryPath: "Entertainment > Streaming Services",
        amount: -22.99,
        description: "Netflix subscription",
        ...clearedStatus,
      });
    }

    const spotifyDate = getMonthDate(year, month, 5);
    if (spotifyDate <= referenceDate && spotifyDate >= startDate) {
      transactions.push({
        accountKey: "visa",
        date: formatDate(spotifyDate),
        payeeName: "Spotify",
        categoryPath: "Entertainment > Streaming Services",
        amount: -11.99,
        description: "Spotify Premium",
        ...clearedStatus,
      });
    }

    const disneyDate = getMonthDate(year, month, 10);
    if (disneyDate <= referenceDate && disneyDate >= startDate) {
      transactions.push({
        accountKey: "mastercard",
        date: formatDate(disneyDate),
        payeeName: "Disney+",
        categoryPath: "Entertainment > Streaming Services",
        amount: -13.99,
        description: "Disney+ subscription",
        ...clearedStatus,
      });
    }

    // === GYM ===
    const gymDate = getMonthDate(year, month, 1);
    if (gymDate <= referenceDate && gymDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(gymDate),
        payeeName: "GoodLife Fitness",
        categoryPath: "Health > Gym",
        amount: -49.99,
        description: "Monthly gym membership",
        ...clearedStatus,
      });
    }

    // === CAR INSURANCE ===
    const insuranceDate = getMonthDate(year, month, 5);
    if (insuranceDate <= referenceDate && insuranceDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(insuranceDate),
        payeeName: "Aviva Insurance",
        categoryPath: "Transportation > Car Insurance",
        amount: -185.0,
        description: "Monthly auto insurance",
        ...clearedStatus,
      });
    }

    // === SAVINGS TRANSFERS ===
    const savingsDate = getMonthDate(year, month, 16);
    if (savingsDate <= referenceDate && savingsDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(savingsDate),
        payeeName: "Transfer",
        categoryPath: "Salary",
        amount: -500.0,
        description: "Monthly savings transfer",
        isTransfer: true,
        transferAccountKey: "savings",
        ...clearedStatus,
      });
    }

    const vacationDate = getMonthDate(year, month, 16);
    if (vacationDate <= referenceDate && vacationDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(vacationDate),
        payeeName: "Transfer",
        categoryPath: "Salary",
        amount: -200.0,
        description: "Vacation fund contribution",
        isTransfer: true,
        transferAccountKey: "vacation",
        ...clearedStatus,
      });
    }

    // === VISA PAYMENT ===
    const visaPayDate = getMonthDate(year, month, 25);
    if (visaPayDate <= referenceDate && visaPayDate >= startDate) {
      // Pay off most of the Visa balance each month (varies a bit)
      const visaPayment = randomBetween(rand, 800, 1400);
      transactions.push({
        accountKey: "chequing",
        date: formatDate(visaPayDate),
        payeeName: "Transfer",
        categoryPath: "Salary",
        amount: -visaPayment,
        description: "Visa payment",
        isTransfer: true,
        transferAccountKey: "visa",
        ...clearedStatus,
      });
    }

    // === GROCERIES (2-3x per month) ===
    const groceryCount = 2 + Math.floor(rand() * 2);
    for (let g = 0; g < groceryCount; g++) {
      const day = 3 + Math.floor(rand() * 25);
      const groceryDate = getMonthDate(year, month, day);
      const stores = ["Loblaws", "No Frills", "Metro", "Costco"];
      const store = stores[Math.floor(rand() * stores.length)];
      const isCostco = store === "Costco";
      const amount = isCostco
        ? randomBetween(rand, 180, 320)
        : randomBetween(rand, 75, 220);
      // Reserved rand draw kept to preserve the seeded random sequence.
      rand();
      const accountRand = rand();

      if (groceryDate <= referenceDate && groceryDate >= startDate) {
        if (isCostco) {
          // Split transaction for Costco
          const groceryAmt = Math.round(amount * 0.7 * 100) / 100;
          const homeGoodsAmt = Math.round((amount - groceryAmt) * 100) / 100;
          transactions.push({
            accountKey: "visa",
            date: formatDate(groceryDate),
            payeeName: store,
            categoryPath: "Food > Groceries",
            amount: -amount,
            description: "Weekly shopping",
            isSplit: true,
            splits: [
              {
                categoryPath: "Food > Groceries",
                amount: -groceryAmt,
                memo: "Groceries",
              },
              {
                categoryPath: "Shopping > Home Goods",
                amount: -homeGoodsAmt,
                memo: "Household items",
              },
            ],
            ...clearedStatus,
          });
        } else {
          transactions.push({
            accountKey: accountRand > 0.4 ? "visa" : "chequing",
            date: formatDate(groceryDate),
            payeeName: store,
            categoryPath: "Food > Groceries",
            amount: -amount,
            description: "Groceries",
            ...clearedStatus,
          });
        }
      }
    }

    // === COFFEE (3-4x per month) ===
    const coffeeCount = 3 + Math.floor(rand() * 2);
    for (let c = 0; c < coffeeCount; c++) {
      const day = 1 + Math.floor(rand() * 28);
      const coffeeDate = getMonthDate(year, month, day);
      if (coffeeDate <= referenceDate && coffeeDate >= startDate) {
        const shop = rand() > 0.6 ? "Starbucks" : "Tim Hortons";
        const amount =
          shop === "Starbucks"
            ? randomBetween(rand, 5.5, 8.5)
            : randomBetween(rand, 2.5, 5.5);
        transactions.push({
          accountKey: "visa",
          date: formatDate(coffeeDate),
          payeeName: shop,
          categoryPath: "Food > Coffee Shops",
          amount: -amount,
          description: "Coffee",
          ...clearedStatus,
        });
      }
    }

    // === GAS (2-3x per month) ===
    const gasCount = 2 + Math.floor(rand() * 2);
    for (let f = 0; f < gasCount; f++) {
      const day = 2 + Math.floor(rand() * 26);
      const fuelDate = getMonthDate(year, month, day);
      if (fuelDate <= referenceDate && fuelDate >= startDate) {
        const station = rand() > 0.5 ? "Shell" : "Esso";
        transactions.push({
          accountKey: "visa",
          date: formatDate(fuelDate),
          payeeName: station,
          categoryPath: "Transportation > Fuel",
          amount: -randomBetween(rand, 55, 90),
          description: "Gas fill-up",
          ...clearedStatus,
        });
      }
    }

    // === TRANSIT (1-2x per month) ===
    const transitCount = 1 + Math.floor(rand() * 2);
    for (let t = 0; t < transitCount; t++) {
      const day = 3 + Math.floor(rand() * 25);
      const transitDate = getMonthDate(year, month, day);
      if (transitDate <= referenceDate && transitDate >= startDate) {
        transactions.push({
          accountKey: "chequing",
          date: formatDate(transitDate),
          payeeName: "TTC",
          categoryPath: "Transportation > Public Transit",
          amount: -randomBetween(rand, 3.35, 6.7),
          description: "Transit fare",
          ...clearedStatus,
        });
      }
    }

    // === RESTAURANTS (2-4x per month) ===
    const restaurantCount = 2 + Math.floor(rand() * 3);
    for (let r = 0; r < restaurantCount; r++) {
      const day = 2 + Math.floor(rand() * 26);
      const restDate = getMonthDate(year, month, day);
      if (restDate <= referenceDate && restDate >= startDate) {
        const restaurants = ["Swiss Chalet", "Uber Eats", "The Keg Steakhouse"];
        const restaurant = restaurants[Math.floor(rand() * restaurants.length)];
        const isKeg = restaurant === "The Keg Steakhouse";
        const amount = isKeg
          ? randomBetween(rand, 80, 150)
          : randomBetween(rand, 25, 65);
        transactions.push({
          accountKey: rand() > 0.3 ? "visa" : "mastercard",
          date: formatDate(restDate),
          payeeName: restaurant,
          categoryPath: "Food > Restaurants",
          amount: -amount,
          description: isKeg ? "Dinner out" : "Takeout / delivery",
          ...clearedStatus,
        });
      }
    }

    // === AMAZON (1-2x per month) ===
    const amazonCount = 1 + Math.floor(rand() * 2);
    for (let a = 0; a < amazonCount; a++) {
      const day = 3 + Math.floor(rand() * 25);
      const amazonDate = getMonthDate(year, month, day);
      if (amazonDate <= referenceDate && amazonDate >= startDate) {
        const categories = [
          { path: "Shopping > Electronics", desc: "Electronics" },
          { path: "Shopping > Home Goods", desc: "Home supplies" },
          { path: "Shopping > Electronics", desc: "Tech accessories" },
        ];
        const cat = categories[Math.floor(rand() * categories.length)];
        transactions.push({
          accountKey: "visa",
          date: formatDate(amazonDate),
          payeeName: "Amazon.ca",
          categoryPath: cat.path,
          amount: -randomBetween(rand, 20, 180),
          description: cat.desc,
          ...clearedStatus,
        });
      }
    }

    // === PHARMACY (1x per month) ===
    const pharmacyDay = 8 + Math.floor(rand() * 20);
    const pharmacyDate = getMonthDate(year, month, pharmacyDay);
    if (pharmacyDate <= referenceDate && pharmacyDate >= startDate) {
      transactions.push({
        accountKey: "chequing",
        date: formatDate(pharmacyDate),
        payeeName: "Shoppers Drug Mart",
        categoryPath: "Health > Pharmacy",
        amount: -randomBetween(rand, 15, 65),
        description: "Pharmacy / personal care",
        ...clearedStatus,
      });
    }

    // === SEASONAL: Holiday spending (December) ===
    if (month === 11) {
      // Christmas gifts
      transactions.push({
        accountKey: "visa",
        date: formatDate(getMonthDate(year, month, 15)),
        payeeName: "Amazon.ca",
        categoryPath: "Gifts & Donations",
        amount: -randomBetween(rand, 200, 400),
        description: "Holiday gifts",
        ...clearedStatus,
      });
      transactions.push({
        accountKey: "mastercard",
        date: formatDate(getMonthDate(year, month, 20)),
        payeeName: "Best Buy",
        categoryPath: "Gifts & Donations",
        amount: -randomBetween(rand, 100, 250),
        description: "Christmas gifts",
        ...clearedStatus,
      });
    }

    // === SEASONAL: Summer travel (July) ===
    if (month === 6) {
      transactions.push({
        accountKey: "visa",
        date: formatDate(getMonthDate(year, month, 5)),
        payeeName: "Air Canada",
        categoryPath: "Travel",
        amount: -randomBetween(rand, 600, 900),
        description: "Summer vacation flights",
        ...clearedStatus,
      });
      transactions.push({
        accountKey: "visa",
        date: formatDate(getMonthDate(year, month, 7)),
        payeeName: "Airbnb",
        categoryPath: "Travel",
        amount: -randomBetween(rand, 500, 800),
        description: "Vacation accommodation",
        ...clearedStatus,
      });
    }

    // === IRREGULAR: Clothing (every 2-3 months) ===
    if (i % 3 === 0) {
      const clothingDay = 10 + Math.floor(rand() * 15);
      const clothingDate = getMonthDate(year, month, clothingDay);
      if (clothingDate <= referenceDate && clothingDate >= startDate) {
        transactions.push({
          accountKey: "mastercard",
          date: formatDate(clothingDate),
          payeeName: "Winners",
          categoryPath: "Shopping > Clothing",
          amount: -randomBetween(rand, 50, 200),
          description: "Clothing",
          ...clearedStatus,
        });
      }
    }

    // === IRREGULAR: Electronics (every 3-4 months) ===
    if (i % 4 === 1) {
      const elecDay = 5 + Math.floor(rand() * 20);
      const elecDate = getMonthDate(year, month, elecDay);
      if (elecDate <= referenceDate && elecDate >= startDate) {
        transactions.push({
          accountKey: "visa",
          date: formatDate(elecDate),
          payeeName: "Best Buy",
          categoryPath: "Shopping > Electronics",
          amount: -randomBetween(rand, 100, 500),
          description: "Electronics purchase",
          ...clearedStatus,
        });
      }
    }

    // === IRREGULAR: IKEA (every 4 months) ===
    if (i % 4 === 2) {
      const ikeaDay = 10 + Math.floor(rand() * 15);
      const ikeaDate = getMonthDate(year, month, ikeaDay);
      if (ikeaDate <= referenceDate && ikeaDate >= startDate) {
        transactions.push({
          accountKey: "visa",
          date: formatDate(ikeaDate),
          payeeName: "IKEA",
          categoryPath: "Shopping > Home Goods",
          amount: -randomBetween(rand, 60, 250),
          description: "Home furnishings",
          ...clearedStatus,
        });
      }
    }

    // === IRREGULAR: Movie (every 2 months) ===
    if (i % 2 === 0) {
      const movieDay = 12 + Math.floor(rand() * 16);
      const movieDate = getMonthDate(year, month, movieDay);
      if (movieDate <= referenceDate && movieDate >= startDate) {
        transactions.push({
          accountKey: "visa",
          date: formatDate(movieDate),
          payeeName: "Cineplex",
          categoryPath: "Entertainment > Movies",
          amount: -randomBetween(rand, 15, 35),
          description: "Movie tickets",
          ...clearedStatus,
        });
      }
    }

    // === IRREGULAR: Doctor visit (every 3 months) ===
    if (i % 3 === 1) {
      const drDay = 5 + Math.floor(rand() * 20);
      const drDate = getMonthDate(year, month, drDay);
      if (drDate <= referenceDate && drDate >= startDate) {
        transactions.push({
          accountKey: "chequing",
          date: formatDate(drDate),
          payeeName: "Dr. Smith",
          categoryPath: "Health > Doctor Visits",
          amount: -randomBetween(rand, 50, 120),
          description: "Medical visit",
          ...clearedStatus,
        });
      }
    }

    // === IRREGULAR: Car maintenance (every 4 months) ===
    if (i % 4 === 3) {
      const carDay = 8 + Math.floor(rand() * 18);
      const carDate = getMonthDate(year, month, carDay);
      if (carDate <= referenceDate && carDate >= startDate) {
        transactions.push({
          accountKey: "chequing",
          date: formatDate(carDate),
          payeeName: "Canadian Tire Auto",
          categoryPath: "Transportation > Maintenance",
          amount: -randomBetween(rand, 80, 350),
          description: "Vehicle maintenance",
          ...clearedStatus,
        });
      }
    }

    // === FREELANCE INCOME (2-3x per quarter) ===
    if (i % 3 === 0) {
      const freelanceDay = 10 + Math.floor(rand() * 15);
      const freelanceDate = getMonthDate(year, month, freelanceDay);
      if (freelanceDate <= referenceDate && freelanceDate >= startDate) {
        transactions.push({
          accountKey: "chequing",
          date: formatDate(freelanceDate),
          payeeName: "Freelance Client - WebDev",
          categoryPath: "Freelance",
          amount: randomBetween(rand, 500, 2000),
          description: "Freelance web development project",
          ...clearedStatus,
        });
      }
    }
  }

  transactions.push(...bitcoinWalletTransactions(referenceDate));

  // Sort by date
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return transactions;
}

/** The day `days` before `referenceDate`. */
function daysBefore(referenceDate: Date, days: number): Date {
  const date = new Date(referenceDate);
  date.setDate(date.getDate() - days);
  return date;
}

/** The status the monthly loop gives a row dated `date`. */
function statusFor(date: Date, referenceDate: Date): string {
  const olderThan2Months =
    new Date(date.getFullYear(), date.getMonth(), 1) <
    new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 2, 1);
  if (olderThan2Months) return "RECONCILED";
  const currentMonth =
    date.getFullYear() === referenceDate.getFullYear() &&
    date.getMonth() === referenceDate.getMonth();
  return currentMonth ? "UNRECONCILED" : "CLEARED";
}

/**
 * The Bitcoin Wallet's history (`docs/specs/crypto-accounts.md` decision 9):
 * bought from Primary Chequing with the bitcoin received stated, spent once,
 * and sold back to chequing as a split whose second line is the network fee.
 * Fixed figures, no draw from the seeded generator, so adding them leaves
 * every other row's figures where they were. The wallet ends at
 * 0.0125 - 0.0004 - 0.0051 = 0.0070 BTC.
 */
function bitcoinWalletTransactions(referenceDate: Date): DemoTransaction[] {
  const bought = daysBefore(referenceDate, 60);
  const spent = daysBefore(referenceDate, 40);
  const sold = daysBefore(referenceDate, 10);
  return [
    {
      accountKey: "chequing",
      date: formatDate(bought),
      payeeName: "Transfer",
      categoryPath: "",
      amount: -1700.0,
      description: "Bought bitcoin",
      status: statusFor(bought, referenceDate),
      isTransfer: true,
      transferAccountKey: "crypto",
      transferToAmount: 0.0125,
    },
    {
      accountKey: "crypto",
      date: formatDate(spent),
      payeeName: "Starbucks",
      categoryPath: "Food > Coffee Shops",
      amount: -0.0004,
      description: "Coffee, paid in bitcoin",
      status: statusFor(spent, referenceDate),
    },
    {
      accountKey: "crypto",
      date: formatDate(sold),
      payeeName: "Transfer",
      categoryPath: "",
      amount: -0.0051,
      description: "Sold bitcoin",
      status: statusFor(sold, referenceDate),
      isSplit: true,
      splits: [
        {
          transferAccountKey: "chequing",
          amount: -0.005,
          memo: "Sold bitcoin",
          transferTargetAmount: 650.0,
        },
        {
          categoryPath: "Fees > Network fee",
          amount: -0.0001,
          memo: "Network fee",
        },
      ],
    },
  ];
}
