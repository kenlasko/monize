import {
  testEmailTemplate,
  billReminderTemplate,
  passwordResetTemplate,
  budgetMonthlySummaryTemplate,
} from "./email-templates";

describe("Email Templates", () => {
  describe("testEmailTemplate()", () => {
    it("includes the provided name in the greeting", () => {
      const html = testEmailTemplate("Alice");

      expect(html).toContain("Hi Alice,");
    });

    it("renders HTML with the test message", () => {
      const html = testEmailTemplate("Bob");

      expect(html).toContain("Monize Test Email");
      expect(html).toContain(
        "This is a test email from Monize. If you received this, your email notifications are working correctly.",
      );
    });

    it('handles empty name by falling back to "there"', () => {
      const html = testEmailTemplate("");

      expect(html).toContain("Hi there,");
    });

    it('handles undefined/falsy name by falling back to "there"', () => {
      const html = testEmailTemplate(undefined as any);

      expect(html).toContain("Hi there,");
    });
  });

  describe("billReminderTemplate()", () => {
    const sampleBills = [
      {
        payee: "Electric Company",
        amount: -150.0,
        dueDate: "2024-02-15",
        currencyCode: "USD",
      },
      {
        payee: "Internet Provider",
        amount: -79.99,
        dueDate: "2024-02-20",
        currencyCode: "USD",
      },
    ];

    it("renders bill rows with payee, dueDate, and formatted amount", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain("Electric Company");
      expect(html).toContain("2024-02-15");
      expect(html).toContain("USD 150.00");
      expect(html).toContain("Internet Provider");
      expect(html).toContain("2024-02-20");
      expect(html).toContain("USD 79.99");
    });

    it("includes the appUrl link to the bills page", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain('href="https://monize.app/bills"');
    });

    it("uses plural grammar for multiple bills", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain("2 upcoming bills");
      expect(html).toContain("that need attention");
    });

    it("uses singular grammar for a single bill", () => {
      const singleBill = [sampleBills[0]];
      const html = billReminderTemplate(
        "Alice",
        singleBill,
        "https://monize.app",
      );

      expect(html).toContain("1 upcoming bill that needs attention");
      expect(html).not.toContain("bills that need");
    });

    it("includes the Upcoming Bill Reminder heading", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain("Upcoming Bill Reminder");
    });
  });

  describe("HTML injection prevention", () => {
    it("escapes HTML in firstName for bill reminder", () => {
      const maliciousName = '<script>alert("xss")</script>';
      const html = billReminderTemplate(maliciousName, [], "https://app.com");

      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes HTML in payee names for bill reminder", () => {
      const bills = [
        {
          payee: '<img src=x onerror="alert(1)">',
          amount: -100,
          dueDate: "2024-01-01",
          currencyCode: "USD",
        },
      ];
      const html = billReminderTemplate("Alice", bills, "https://app.com");

      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    });

    it("escapes HTML in firstName for password reset", () => {
      const maliciousName = '"><a href="https://evil.com">Click</a>';
      const html = passwordResetTemplate(
        maliciousName,
        "https://app.com/reset?token=abc",
      );

      expect(html).not.toContain('href="https://evil.com"');
      expect(html).toContain("&quot;&gt;&lt;a");
    });

    it("escapes HTML in firstName for test email", () => {
      const html = testEmailTemplate("<b>Bold</b>");

      expect(html).not.toContain("<b>Bold</b>");
      expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    });

    it("escapes ampersands in user data", () => {
      const html = testEmailTemplate("Tom & Jerry");

      expect(html).toContain("Tom &amp; Jerry");
    });

    it("escapes quotes in payee currency codes", () => {
      const bills = [
        {
          payee: "Normal",
          amount: -50,
          dueDate: "2024-01-01",
          currencyCode: '"onmouseover="alert(1)',
        },
      ];
      const html = billReminderTemplate("Alice", bills, "https://app.com");

      expect(html).not.toContain('"onmouseover=');
      expect(html).toContain("&quot;onmouseover=");
    });
  });

  describe("passwordResetTemplate()", () => {
    it("includes the resetUrl in the reset button link", () => {
      const html = passwordResetTemplate(
        "Alice",
        "https://monize.app/reset?token=abc123",
      );

      expect(html).toContain('href="https://monize.app/reset?token=abc123"');
    });

    it("includes the name in the greeting", () => {
      const html = passwordResetTemplate(
        "Bob",
        "https://monize.app/reset?token=xyz",
      );

      expect(html).toContain("Hi Bob,");
    });

    it("includes the expiration notice", () => {
      const html = passwordResetTemplate(
        "Alice",
        "https://monize.app/reset?token=abc123",
      );

      expect(html).toContain("This link will expire in 1 hour");
    });

    it("includes the safe-to-ignore notice", () => {
      const html = passwordResetTemplate(
        "Alice",
        "https://monize.app/reset?token=abc123",
      );

      expect(html).toContain(
        "If you did not request a password reset, you can safely ignore this email",
      );
    });

    it('falls back to "there" when name is empty', () => {
      const html = passwordResetTemplate(
        "",
        "https://monize.app/reset?token=abc123",
      );

      expect(html).toContain("Hi there,");
    });

    it("includes the Password Reset Request heading", () => {
      const html = passwordResetTemplate(
        "Alice",
        "https://monize.app/reset?token=abc123",
      );

      expect(html).toContain("Password Reset Request");
    });
  });

  describe("budgetMonthlySummaryTemplate()", () => {
    const sampleSummaries = [
      {
        budgetName: "Monthly Household",
        periodLabel: "January 2026",
        totalBudgeted: 4000,
        totalSpent: 3200,
        totalIncome: 6000,
        remaining: 800,
        percentUsed: 80,
        healthScore: 85,
        healthLabel: "Good",
        overBudgetCategories: [
          {
            categoryName: "Dining Out",
            budgeted: 400,
            actual: 520,
            percentUsed: 130,
          },
        ],
        topCategories: [
          {
            categoryName: "Rent",
            budgeted: 2000,
            actual: 2000,
            percentUsed: 100,
          },
          {
            categoryName: "Groceries",
            budgeted: 800,
            actual: 650,
            percentUsed: 81.25,
          },
          {
            categoryName: "Dining Out",
            budgeted: 400,
            actual: 520,
            percentUsed: 130,
          },
        ],
      },
    ];

    it("generates valid HTML with proper structure", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Monthly Budget Summary");
      expect(html).toContain("Hi Alice,");
      expect(html).toContain(
        "monthly budget summary for the period that just closed",
      );
      expect(html).toContain("-- Monize");
    });

    it("includes budget name and period label", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Monthly Household");
      expect(html).toContain("January 2026");
    });

    it("includes budget totals", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("$4000.00");
      expect(html).toContain("$3200.00");
      expect(html).toContain("$800.00");
    });

    it("shows percent used", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("80.0% used");
    });

    it("shows progress bar with correct percentage", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      // The progress bar div has width set to percentUsed capped at 100%
      expect(html).toContain("width: 80%");
    });

    it("caps progress bar at 100% for over-budget scenarios", () => {
      const overBudgetSummary = [
        {
          ...sampleSummaries[0],
          totalSpent: 5000,
          remaining: -1000,
          percentUsed: 125,
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        overBudgetSummary,
        "https://monize.app",
      );

      expect(html).toContain("width: 100%");
      expect(html).not.toContain("width: 125%");
    });

    it("shows over-budget categories section", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Over Budget");
      expect(html).toContain("Dining Out");
      expect(html).toContain("130%");
      expect(html).toContain("$520.00");
      expect(html).toContain("$400.00");
    });

    it("does not show over-budget section when no categories are over", () => {
      const underBudgetSummary = [
        {
          ...sampleSummaries[0],
          overBudgetCategories: [],
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        underBudgetSummary,
        "https://monize.app",
      );

      expect(html).not.toContain("Over Budget");
    });

    it("shows top categories section", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Top Categories");
      expect(html).toContain("Rent");
      expect(html).toContain("Groceries");
      expect(html).toContain("Dining Out");
    });

    it("shows health score when provided", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Health Score");
      expect(html).toContain("85/100");
      expect(html).toContain("Good");
    });

    it("does not show health score when null", () => {
      const noHealthSummary = [
        {
          ...sampleSummaries[0],
          healthScore: null,
          healthLabel: null,
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        noHealthSummary,
        "https://monize.app",
      );

      expect(html).not.toContain("Health Score");
    });

    it("includes the app URL link to budgets page", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain('href="https://monize.app/budgets"');
      expect(html).toContain("View Budget Dashboard");
    });

    it('falls back to "there" when firstName is empty', () => {
      const html = budgetMonthlySummaryTemplate(
        "",
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Hi there,");
    });

    it("escapes HTML entities in user-controlled data", () => {
      const maliciousSummary = [
        {
          ...sampleSummaries[0],
          budgetName: '<script>alert("xss")</script>',
          periodLabel: '"><img src=x>',
          topCategories: [
            {
              categoryName: "<b>Dangerous</b>",
              budgeted: 100,
              actual: 50,
              percentUsed: 50,
            },
          ],
          overBudgetCategories: [
            {
              categoryName: "&\"<>'",
              budgeted: 100,
              actual: 200,
              percentUsed: 200,
            },
          ],
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        '<script>alert("name")</script>',
        maliciousSummary,
        "https://monize.app",
      );

      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<b>Dangerous</b>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;b&gt;Dangerous&lt;/b&gt;");
      expect(html).toContain("&amp;&quot;&lt;&gt;&#039;");
    });

    it("escapes HTML in firstName", () => {
      const html = budgetMonthlySummaryTemplate(
        '<img src=x onerror="alert(1)">',
        sampleSummaries,
        "https://monize.app",
      );

      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    });

    it("handles multiple budget summaries", () => {
      const multiSummaries = [
        sampleSummaries[0],
        {
          ...sampleSummaries[0],
          budgetName: "Annual Savings",
          periodLabel: "January 2026",
          totalBudgeted: 1000,
          totalSpent: 500,
          remaining: 500,
          percentUsed: 50,
          healthScore: null,
          healthLabel: null,
          overBudgetCategories: [],
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        multiSummaries,
        "https://monize.app",
      );

      expect(html).toContain("Monthly Household");
      expect(html).toContain("Annual Savings");
      expect(html).toContain("$4000.00");
      expect(html).toContain("$1000.00");
    });

    it("uses correct color for good health score (green)", () => {
      const html = budgetMonthlySummaryTemplate(
        "Alice",
        sampleSummaries,
        "https://monize.app",
      );

      // Health score of 85 >= 80, so it should use green (#059669)
      expect(html).toContain("#059669");
    });

    it("uses correct color for medium health score (amber)", () => {
      const mediumHealthSummary = [
        {
          ...sampleSummaries[0],
          healthScore: 65,
          healthLabel: "Needs Attention",
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        mediumHealthSummary,
        "https://monize.app",
      );

      expect(html).toContain("#d97706");
      expect(html).toContain("65/100");
    });

    it("uses correct color for low health score (red)", () => {
      const lowHealthSummary = [
        {
          ...sampleSummaries[0],
          healthScore: 40,
          healthLabel: "Off Track",
        },
      ];

      const html = budgetMonthlySummaryTemplate(
        "Alice",
        lowHealthSummary,
        "https://monize.app",
      );

      expect(html).toContain("#dc2626");
      expect(html).toContain("40/100");
    });
  });
});
