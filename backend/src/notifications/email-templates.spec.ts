import {
  testEmailTemplate,
  billReminderTemplate,
  passwordResetTemplate,
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
});
