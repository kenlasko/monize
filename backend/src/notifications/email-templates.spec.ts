import {
  testEmailTemplate,
  billReminderTemplate,
  passwordResetTemplate,
  accountInviteTemplate,
  budgetMonthlySummaryTemplate,
  mortgageReminderTemplate,
  budgetAlertImmediateTemplate,
  budgetWeeklyDigestTemplate,
  oidcLinkTemplate,
  accountLockedTemplate,
  emergencyAccessReminderTemplate,
  emergencyAccessGrantTemplate,
  emergencyAccessGrantRevokedTemplate,
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
        amount: 150.0,
        dueDate: "2024-02-15",
        currencyCode: "USD",
        isIncome: false,
      },
      {
        payee: "Internet Provider",
        amount: 79.99,
        dueDate: "2024-02-20",
        currencyCode: "USD",
        isIncome: false,
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
      expect(html).toContain("$150.00");
      expect(html).toContain("Internet Provider");
      expect(html).toContain("2024-02-20");
      expect(html).toContain("$79.99");
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

    it("shows expense bills in red", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain("Expense");
      expect(html).toContain("#dc2626");
    });

    it("shows income bills in green", () => {
      const incomeBills = [
        {
          payee: "Employer",
          amount: 3000.0,
          dueDate: "2024-02-28",
          currencyCode: "USD",
          isIncome: true,
        },
      ];
      const html = billReminderTemplate(
        "Alice",
        incomeBills,
        "https://monize.app",
      );

      expect(html).toContain("Income");
      expect(html).toContain("#059669");
    });

    it("shows Type column header", () => {
      const html = billReminderTemplate(
        "Alice",
        sampleBills,
        "https://monize.app",
      );

      expect(html).toContain(">Type</th>");
    });

    it("distinguishes income and expense in mixed list", () => {
      const mixedBills = [
        {
          payee: "Electric Company",
          amount: 150.0,
          dueDate: "2024-02-15",
          currencyCode: "USD",
          isIncome: false,
        },
        {
          payee: "Salary Deposit",
          amount: 5000.0,
          dueDate: "2024-02-28",
          currencyCode: "USD",
          isIncome: true,
        },
      ];
      const html = billReminderTemplate(
        "Alice",
        mixedBills,
        "https://monize.app",
      );

      expect(html).toContain("Expense");
      expect(html).toContain("Income");
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
          amount: 100,
          dueDate: "2024-01-01",
          currencyCode: "USD",
          isIncome: false,
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

    it("handles invalid currency codes safely in bill amounts", () => {
      const bills = [
        {
          payee: "Normal",
          amount: 50,
          dueDate: "2024-01-01",
          currencyCode: '"onmouseover="alert(1)',
          isIncome: false,
        },
      ];
      const html = billReminderTemplate("Alice", bills, "https://app.com");

      // formatCurrency catches the invalid code and falls back to plain number
      expect(html).not.toContain('"onmouseover=');
      expect(html).toContain("50.00");
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

  describe("accountInviteTemplate()", () => {
    it("includes the invite url in the set-password button link", () => {
      const html = accountInviteTemplate(
        "Alice",
        "https://monize.app/reset-password?token=abc123",
      );

      expect(html).toContain(
        'href="https://monize.app/reset-password?token=abc123"',
      );
    });

    it("includes the name in the greeting", () => {
      const html = accountInviteTemplate("Bob", "https://monize.app/x");

      expect(html).toContain("Hi Bob,");
    });

    it('falls back to "there" when name is empty', () => {
      const html = accountInviteTemplate("", "https://monize.app/x");

      expect(html).toContain("Hi there,");
    });

    it("mentions that an administrator created the account", () => {
      const html = accountInviteTemplate("Alice", "https://monize.app/x");

      expect(html).toContain("An administrator has created a Monize account");
      expect(html).toContain("This link will expire in 24 hours");
    });

    it("escapes HTML in the name to prevent injection", () => {
      const html = accountInviteTemplate(
        "<script>alert(1)</script>",
        "https://monize.app/x",
      );

      expect(html).not.toContain("<script>alert(1)</script>");
    });
  });

  describe("budgetMonthlySummaryTemplate()", () => {
    const sampleSummaries = [
      {
        budgetName: "Monthly Household",
        currencyCode: "USD",
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

      expect(html).toContain("$4,000.00");
      expect(html).toContain("$3,200.00");
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
      expect(html).toContain("&amp;&quot;&lt;&gt;&apos;");
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
      expect(html).toContain("$4,000.00");
      expect(html).toContain("$1,000.00");
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

  describe("mortgageReminderTemplate()", () => {
    const sampleMortgages = [
      {
        name: "Home Mortgage",
        termEndDate: "2026-06-15",
        daysUntilRenewal: 45,
      },
      {
        name: "Cottage Mortgage",
        termEndDate: "2026-05-01",
        daysUntilRenewal: 15,
      },
    ];

    it("renders the greeting with the provided name", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain("Hi Alice,");
    });

    it("renders mortgage rows with name, term end date, and days", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain("Home Mortgage");
      expect(html).toContain("2026-06-15");
      expect(html).toContain("45 days");
      expect(html).toContain("Cottage Mortgage");
      expect(html).toContain("2026-05-01");
      expect(html).toContain("15 days");
    });

    it("includes the Mortgage Renewal Reminder heading", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain("Mortgage Renewal Reminder");
    });

    it("uses plural grammar for multiple mortgages", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain("2 mortgages");
    });

    it("uses singular grammar for a single mortgage", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        [sampleMortgages[0]],
        "https://monize.app",
      );

      expect(html).toContain("1 mortgage with an upcoming term renewal");
    });

    it("uses singular day for 1 day remaining", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        [{ name: "Home", termEndDate: "2026-04-17", daysUntilRenewal: 1 }],
        "https://monize.app",
      );

      expect(html).toContain("1 day<");
      expect(html).not.toContain("1 days");
    });

    it("uses red color for mortgages within 30 days", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        [{ name: "Urgent", termEndDate: "2026-05-01", daysUntilRenewal: 15 }],
        "https://monize.app",
      );

      expect(html).toContain("#dc2626");
    });

    it("uses amber color for mortgages between 31 and 60 days", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        [{ name: "Soon", termEndDate: "2026-06-15", daysUntilRenewal: 45 }],
        "https://monize.app",
      );

      expect(html).toContain("#d97706");
    });

    it("includes the appUrl link to the accounts page", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain('href="https://monize.app/accounts"');
      expect(html).toContain("View Accounts");
    });

    it('falls back to "there" when firstName is empty', () => {
      const html = mortgageReminderTemplate(
        "",
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).toContain("Hi there,");
    });

    it("escapes HTML in mortgage names", () => {
      const html = mortgageReminderTemplate(
        "Alice",
        [
          {
            name: '<script>alert("xss")</script>',
            termEndDate: "2026-06-15",
            daysUntilRenewal: 45,
          },
        ],
        "https://monize.app",
      );

      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes HTML in firstName", () => {
      const html = mortgageReminderTemplate(
        '<img src=x onerror="alert(1)">',
        sampleMortgages,
        "https://monize.app",
      );

      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    });
  });

  describe("budgetAlertImmediateTemplate()", () => {
    it("renders critical/warning/success/default severity colors and labels", () => {
      const html = budgetAlertImmediateTemplate(
        "Sam",
        [
          {
            title: "T1",
            message: "M1",
            severity: "critical",
            categoryName: "Food",
          },
          {
            title: "T2",
            message: "M2",
            severity: "warning",
            categoryName: "Food",
          },
          {
            title: "T3",
            message: "M3",
            severity: "success",
            categoryName: "Food",
          },
          {
            title: "T4",
            message: "M4",
            severity: "info",
            categoryName: "Food",
          },
        ],
        "https://app",
      );
      expect(html).toContain("#dc2626");
      expect(html).toContain("#d97706");
      expect(html).toContain("#059669");
      expect(html).toContain("#2563eb");
      expect(html).toContain("Critical");
      expect(html).toContain("Warning");
      expect(html).toContain("Good News");
      expect(html).toContain("Info");
    });

    it("falls back to 'there' when firstName is empty", () => {
      const html = budgetAlertImmediateTemplate("", [], "https://app");
      expect(html).toContain("Hi there");
    });
  });

  describe("budgetWeeklyDigestTemplate()", () => {
    const baseAlerts = [
      { title: "C1", message: "m", severity: "critical", categoryName: "" },
      { title: "W1", message: "m", severity: "warning", categoryName: "" },
      { title: "W2", message: "m", severity: "warning", categoryName: "" },
      { title: "P1", message: "m", severity: "success", categoryName: "" },
    ];

    it("includes critical, plural warnings, and positive counts", () => {
      const html = budgetWeeklyDigestTemplate(
        "Alex",
        baseAlerts,
        ["Budget A"],
        "https://app",
      );
      expect(html).toContain("1 critical");
      expect(html).toContain("2 warnings");
      expect(html).toContain("1 positive");
    });

    it("uses singular 'warning' when count is 1", () => {
      const html = budgetWeeklyDigestTemplate(
        "Alex",
        [{ title: "W", message: "m", severity: "warning", categoryName: "" }],
        ["B"],
        "https://app",
      );
      expect(html).toContain("1 warning");
      expect(html).not.toContain("1 warnings");
    });

    it("renders 'No alerts' fallback when summary is empty", () => {
      const html = budgetWeeklyDigestTemplate("Alex", [], ["B"], "https://app");
      expect(html).toContain("No alerts");
    });

    it("includes '...and N more' when alerts > 5", () => {
      const many = Array.from({ length: 7 }, (_, i) => ({
        title: `t${i}`,
        message: "m",
        severity: "critical",
        categoryName: "",
      }));
      const html = budgetWeeklyDigestTemplate(
        "Alex",
        many,
        ["B"],
        "https://app",
      );
      expect(html).toContain("and 2 more");
    });

    it("falls back to 'there' when firstName empty", () => {
      const html = budgetWeeklyDigestTemplate("", [], ["B"], "https://app");
      expect(html).toContain("Hi there");
    });
  });

  describe("oidcLinkTemplate()", () => {
    it("renders confirmation URL safely", () => {
      const html = oidcLinkTemplate("Sam", "https://link/confirm?t=abc");
      expect(html).toContain("https://link/confirm?t=abc");
      expect(html).toContain("Hi Sam");
    });
    it("falls back to 'there' when name is empty", () => {
      const html = oidcLinkTemplate("", "https://x");
      expect(html).toContain("Hi there");
    });
  });

  describe("accountLockedTemplate()", () => {
    it("renders default name when none supplied", () => {
      const html = accountLockedTemplate("");
      expect(html).toContain("Hi there");
    });
    it("renders supplied name", () => {
      const html = accountLockedTemplate("Pat");
      expect(html).toContain("Hi Pat");
    });
  });

  describe("emergencyAccessReminderTemplate()", () => {
    const baseData = {
      ownerFirstName: "Owner",
      daysSinceLogin: 9,
      daysUntilGrant: 5,
      contacts: [
        { firstName: "Carol", email: "carol@example.com" },
        { firstName: "Dave", email: "dave@example.com" },
      ],
      appUrl: "https://monize.example",
    };

    it("greets the owner and surfaces the inactivity window", () => {
      const html = emergencyAccessReminderTemplate(baseData);
      expect(html).toContain("Hi Owner");
      expect(html).toContain("9 days");
      expect(html).toContain("5 days");
    });

    it("renders every designated contact", () => {
      const html = emergencyAccessReminderTemplate(baseData);
      expect(html).toContain("Carol");
      expect(html).toContain("carol@example.com");
      expect(html).toContain("Dave");
      expect(html).toContain("dave@example.com");
    });

    it("links to /login on the public app URL", () => {
      const html = emergencyAccessReminderTemplate(baseData);
      expect(html).toContain('href="https://monize.example/login"');
    });

    it("escapes injected HTML in contact data", () => {
      const html = emergencyAccessReminderTemplate({
        ...baseData,
        contacts: [
          {
            firstName: "<script>alert(1)</script>",
            email: "x@y.com",
          },
        ],
      });
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it('handles 1-day windows with singular phrasing ("today")', () => {
      const html = emergencyAccessReminderTemplate({
        ...baseData,
        daysSinceLogin: 1,
        daysUntilGrant: 0,
      });
      expect(html).toContain("1 day");
      expect(html).toContain("today");
    });
  });

  describe("emergencyAccessGrantTemplate()", () => {
    const baseData = {
      contactFirstName: "Carol",
      ownerFullName: "Owner One",
      message: "Bank passwords are in the safe.\nCall my lawyer.",
      claimUrl: "https://monize.example/emergency-access/claim?token=ABC",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    };

    it("addresses the contact and identifies the owner", () => {
      const html = emergencyAccessGrantTemplate(baseData);
      expect(html).toContain("Hi Carol");
      expect(html).toContain("Owner One");
    });

    it("renders the claim URL", () => {
      const html = emergencyAccessGrantTemplate(baseData);
      expect(html).toContain(
        'href="https://monize.example/emergency-access/claim?token=ABC"',
      );
    });

    it("includes the message with newlines preserved as <br>", () => {
      const html = emergencyAccessGrantTemplate(baseData);
      expect(html).toContain("Bank passwords are in the safe.");
      expect(html).toContain("<br>Call my lawyer.");
    });

    it("omits the message block when no message is provided", () => {
      const html = emergencyAccessGrantTemplate({
        ...baseData,
        message: null,
      });
      expect(html).not.toContain("border-left: 4px solid");
    });

    it("escapes injected HTML in the message", () => {
      const html = emergencyAccessGrantTemplate({
        ...baseData,
        message: "<img src=x onerror=alert(1)>",
      });
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img");
    });

    it("shows the expiry date in ISO-day form", () => {
      const html = emergencyAccessGrantTemplate(baseData);
      expect(html).toContain("2030-01-01");
    });
  });

  describe("emergencyAccessGrantRevokedTemplate()", () => {
    it("greets the owner and explains the links were revoked", () => {
      const html = emergencyAccessGrantRevokedTemplate({
        ownerFirstName: "Owner",
        appUrl: "https://app.example.com",
      });
      expect(html).toContain("Hi Owner");
      expect(html).toContain("revoked");
      expect(html).toContain(
        "https://app.example.com/settings/emergency-access",
      );
    });

    it('falls back to "there" for a blank name', () => {
      const html = emergencyAccessGrantRevokedTemplate({
        ownerFirstName: "",
        appUrl: "https://app.example.com",
      });
      expect(html).toContain("Hi there");
    });

    it("escapes HTML in the owner name", () => {
      const html = emergencyAccessGrantRevokedTemplate({
        ownerFirstName: "<img src=x onerror=alert(1)>",
        appUrl: "https://app.example.com",
      });
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img");
    });
  });
});
