import {
  DEMO_GROSS_SALARY,
  DEMO_REGULAR_NET_PAY,
  demoPayrollDeductions,
  payrollPaycheque,
} from "./payroll";
import { demoSharedGroups } from "./shared-expenses";
import { demoWarranties } from "./warranties";
import { demoScheduledTransactions } from "./scheduled";
import { generateTransactions } from "./transactions";

const cents = (n: number) => Math.round(n * 100);

describe("demo payroll", () => {
  it("caps each deduction at its yearly maximum", () => {
    const ytd = new Map<string, number>();
    const paid = new Map<string, number>();
    for (let i = 0; i < 24; i++) {
      for (const s of payrollPaycheque(ytd).splits) {
        if (s.amount < 0)
          paid.set(
            s.categoryPath!,
            (paid.get(s.categoryPath!) ?? 0) - s.amount,
          );
      }
    }
    for (const d of demoPayrollDeductions) {
      if (d.yearlyMaximum === undefined) continue;
      // A cap the year reaches, to the cent, and never exceeds.
      expect(cents(paid.get(d.categoryPath)!)).toBe(cents(d.yearlyMaximum));
    }
  });

  it("nets the deductions off the gross, and the bill matches a full paycheque", () => {
    const { net, splits } = payrollPaycheque(new Map());
    expect(net).toBe(DEMO_REGULAR_NET_PAY);
    expect(cents(splits.reduce((s, x) => s + x.amount, 0))).toBe(cents(net));
    const bill = demoScheduledTransactions.find((s) => s.splits)!;
    expect(bill.amount).toBe(net);
    expect(cents(bill.splits!.reduce((s, x) => s + x.amount, 0))).toBe(
      cents(bill.amount),
    );
    expect(bill.splits![0].amount).toBe(DEMO_GROSS_SALARY);
  });

  it("posts each paycheque as a split whose lines add up to the deposit", () => {
    const salary = generateTransactions(new Date()).filter(
      (t) => t.payeeName === "Maple Leaf Technologies",
    );
    expect(salary.length).toBeGreaterThan(20);
    for (const t of salary) {
      expect(t.isSplit).toBe(true);
      expect(cents(t.splits!.reduce((s, x) => s + x.amount, 0))).toBe(
        cents(t.amount),
      );
    }
  });
});

describe("demo shared expenses", () => {
  it("allocates every expense in full, as the database requires", () => {
    for (const group of demoSharedGroups) {
      const members = new Set([group.myName, ...group.others]);
      for (const e of group.entries) {
        expect(members.has(e.payer)).toBe(true);
        if (e.type === "REPAYMENT") {
          expect(e.recipient && members.has(e.recipient)).toBe(true);
          expect(e.recipient).not.toBe(e.payer);
          continue;
        }
        const total = e.shares!.reduce((s, x) => s + cents(x.amount), 0);
        expect(total).toBe(cents(e.amount));
        for (const s of e.shares!) expect(members.has(s.name)).toBe(true);
      }
    }
  });

  it("covers every split mode the feature offers except none", () => {
    const modes = new Set(
      demoSharedGroups.flatMap((g) =>
        g.entries
          .filter((e) => e.type === "EXPENSE")
          .map((e) => e.splitMode ?? "EQUAL"),
      ),
    );
    expect([...modes].sort()).toEqual(["EQUAL", "EXACT", "PERCENT", "WEIGHT"]);
  });
});

describe("demo warranties", () => {
  it("satisfies the table's expiry rules and spans the page's states", () => {
    for (const w of demoWarranties) {
      expect(w.isLifetime || w.expiresInDays !== undefined).toBe(true);
    }
    expect(demoWarranties.some((w) => w.isLifetime)).toBe(true);
    expect(demoWarranties.some((w) => w.archived)).toBe(true);
    expect(demoWarranties.some((w) => (w.expiresInDays ?? 1) < 0)).toBe(true);
    expect(
      demoWarranties.some(
        (w) =>
          w.expiresInDays !== undefined &&
          w.expiresInDays > 0 &&
          w.expiresInDays <= 30,
      ),
    ).toBe(true);
    const claims = demoWarranties.flatMap((w) => w.claims ?? []);
    expect(new Set(claims.map((c) => c.status)).size).toBeGreaterThanOrEqual(3);
  });

  it("never expires a warranty before it was bought", () => {
    for (const w of demoWarranties) {
      if (w.expiresInDays === undefined) continue;
      expect(w.expiresInDays).toBeGreaterThan(-w.purchasedMonthsAgo * 28);
    }
  });
});
