/**
 * Escape HTML entities to prevent HTML injection in email templates.
 * User-controlled data (names, payee fields) must be escaped before
 * interpolation into HTML to prevent phishing via injected markup.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function testEmailTemplate(firstName: string): string {
  const safeName = escapeHtml(firstName || "there");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Monize Test Email</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">This is a test email from Monize. If you received this, your email notifications are working correctly.</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface BillData {
  payee: string;
  amount: number;
  dueDate: string;
  currencyCode: string;
}

export function billReminderTemplate(
  firstName: string,
  bills: BillData[],
  appUrl: string,
): string {
  const safeName = escapeHtml(firstName || "there");
  const billRows = bills
    .map(
      (b) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(b.payee)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(b.dueDate)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${escapeHtml(b.currencyCode)} ${Math.abs(b.amount).toFixed(2)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Upcoming Bill Reminder</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">You have ${bills.length} upcoming bill${bills.length === 1 ? "" : "s"} that need${bills.length === 1 ? "s" : ""} attention:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">Payee</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">Due Date</th>
            <th style="padding: 10px 12px; text-align: right; font-weight: 600; color: #374151;">Amount</th>
          </tr>
        </thead>
        <tbody>${billRows}</tbody>
      </table>
      <p style="margin-top: 20px;">
        <a href="${appUrl}/bills" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">View Bills &amp; Deposits</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface BudgetAlertData {
  title: string;
  message: string;
  severity: string;
  categoryName: string;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "#dc2626";
    case "warning":
      return "#d97706";
    case "success":
      return "#059669";
    default:
      return "#2563eb";
  }
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "warning":
      return "Warning";
    case "success":
      return "Good News";
    default:
      return "Info";
  }
}

export function budgetAlertImmediateTemplate(
  firstName: string,
  alerts: BudgetAlertData[],
  appUrl: string,
): string {
  const safeName = escapeHtml(firstName || "there");
  const alertRows = alerts
    .map(
      (a) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; color: white; background: ${severityColor(a.severity)};">
              ${escapeHtml(severityLabel(a.severity))}
            </span>
          </td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${escapeHtml(a.title)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${escapeHtml(a.message)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Budget Alert</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">Your budget needs attention:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">Severity</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">Alert</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">Details</th>
          </tr>
        </thead>
        <tbody>${alertRows}</tbody>
      </table>
      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">View Budget</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function budgetWeeklyDigestTemplate(
  firstName: string,
  alerts: BudgetAlertData[],
  budgetNames: string[],
  appUrl: string,
): string {
  const safeName = escapeHtml(firstName || "there");

  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const warningAlerts = alerts.filter((a) => a.severity === "warning");
  const positiveAlerts = alerts.filter((a) => a.severity === "success");

  const alertSummary: string[] = [];
  if (criticalAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #dc2626; font-weight: 600;">${criticalAlerts.length} critical</span>`,
    );
  }
  if (warningAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #d97706; font-weight: 600;">${warningAlerts.length} warning${warningAlerts.length !== 1 ? "s" : ""}</span>`,
    );
  }
  if (positiveAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #059669; font-weight: 600;">${positiveAlerts.length} positive</span>`,
    );
  }

  const topAlerts = alerts.slice(0, 5);
  const alertRows = topAlerts
    .map(
      (a) =>
        `<li style="margin-bottom: 8px;">
          <span style="display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; color: white; background: ${severityColor(a.severity)}; vertical-align: middle;">
            ${escapeHtml(severityLabel(a.severity))}
          </span>
          <span style="color: #374151; margin-left: 4px;">${escapeHtml(a.title)}</span>
        </li>`,
    )
    .join("");

  const safeBudgetNames = budgetNames.map((n) => escapeHtml(n)).join(", ");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Weekly Budget Summary</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">Here is your weekly budget summary for: <strong>${safeBudgetNames}</strong></p>

      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px 0; color: #374151; font-weight: 600;">This Week: ${alertSummary.join(", ") || "No alerts"}</p>
        <p style="margin: 0; color: #6b7280; font-size: 14px;">Total alerts: ${alerts.length}</p>
      </div>

      ${
        topAlerts.length > 0
          ? `
        <h3 style="color: #374151; font-size: 16px; margin-top: 20px;">Top Alerts</h3>
        <ul style="padding-left: 0; list-style: none;">${alertRows}</ul>
        ${alerts.length > 5 ? `<p style="color: #6b7280; font-size: 14px;">...and ${alerts.length - 5} more</p>` : ""}
      `
          : ""
      }

      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">View Budget Dashboard</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface MonthlySummaryCategoryData {
  categoryName: string;
  budgeted: number;
  actual: number;
  percentUsed: number;
}

interface MonthlySummaryData {
  budgetName: string;
  periodLabel: string;
  totalBudgeted: number;
  totalSpent: number;
  totalIncome: number;
  remaining: number;
  percentUsed: number;
  healthScore: number | null;
  healthLabel: string | null;
  overBudgetCategories: MonthlySummaryCategoryData[];
  topCategories: MonthlySummaryCategoryData[];
}

function healthScoreColor(score: number): string {
  if (score >= 80) return "#059669";
  if (score >= 60) return "#d97706";
  return "#dc2626";
}

export function budgetMonthlySummaryTemplate(
  firstName: string,
  summaries: MonthlySummaryData[],
  appUrl: string,
): string {
  const safeName = escapeHtml(firstName || "there");

  const budgetSections = summaries
    .map((s) => {
      const percentColor =
        s.percentUsed > 100
          ? "#dc2626"
          : s.percentUsed > 80
            ? "#d97706"
            : "#059669";

      const overBudgetRows =
        s.overBudgetCategories.length > 0
          ? `
          <h4 style="color: #dc2626; font-size: 14px; margin: 12px 0 8px 0;">Over Budget</h4>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
            ${s.overBudgetCategories
              .map(
                (c) =>
                  `<tr>
                    <td style="padding: 4px 8px; color: #374151; font-size: 14px;">${escapeHtml(c.categoryName)}</td>
                    <td style="padding: 4px 8px; text-align: right; color: #dc2626; font-size: 14px; font-weight: 600;">${c.percentUsed.toFixed(0)}%</td>
                    <td style="padding: 4px 8px; text-align: right; color: #6b7280; font-size: 14px;">$${c.actual.toFixed(2)} / $${c.budgeted.toFixed(2)}</td>
                  </tr>`,
              )
              .join("")}
          </table>`
          : "";

      const topCategoryRows = s.topCategories
        .map(
          (c) =>
            `<tr>
              <td style="padding: 4px 8px; color: #374151; font-size: 14px;">${escapeHtml(c.categoryName)}</td>
              <td style="padding: 4px 8px; text-align: right; font-size: 14px;">
                <span style="color: ${c.percentUsed > 100 ? "#dc2626" : c.percentUsed > 80 ? "#d97706" : "#059669"}; font-weight: 600;">${c.percentUsed.toFixed(0)}%</span>
              </td>
              <td style="padding: 4px 8px; text-align: right; color: #6b7280; font-size: 14px;">$${c.actual.toFixed(2)} / $${c.budgeted.toFixed(2)}</td>
            </tr>`,
        )
        .join("");

      const healthSection =
        s.healthScore !== null
          ? `<p style="margin: 8px 0; color: #374151; font-size: 14px;">
              Health Score: <span style="color: ${healthScoreColor(s.healthScore)}; font-weight: 700;">${s.healthScore}/100</span>
              <span style="color: #6b7280;"> (${escapeHtml(s.healthLabel || "")})</span>
            </p>`
          : "";

      return `
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <h3 style="color: #1f2937; font-size: 16px; margin: 0 0 12px 0;">${escapeHtml(s.budgetName)} - ${escapeHtml(s.periodLabel)}</h3>

          <div style="display: flex; gap: 16px; margin-bottom: 12px;">
            <div>
              <span style="color: #6b7280; font-size: 12px;">Budgeted</span><br/>
              <span style="color: #374151; font-weight: 600;">$${s.totalBudgeted.toFixed(2)}</span>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 12px;">Spent</span><br/>
              <span style="color: ${percentColor}; font-weight: 600;">$${s.totalSpent.toFixed(2)}</span>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 12px;">Remaining</span><br/>
              <span style="color: ${s.remaining >= 0 ? "#059669" : "#dc2626"}; font-weight: 600;">$${s.remaining.toFixed(2)}</span>
            </div>
          </div>

          <div style="background: #e5e7eb; border-radius: 4px; height: 8px; margin-bottom: 8px;">
            <div style="background: ${percentColor}; border-radius: 4px; height: 8px; width: ${Math.min(s.percentUsed, 100)}%;"></div>
          </div>
          <p style="margin: 0 0 8px 0; color: ${percentColor}; font-weight: 600; font-size: 14px;">${s.percentUsed.toFixed(1)}% used</p>

          ${healthSection}
          ${overBudgetRows}

          <h4 style="color: #374151; font-size: 14px; margin: 12px 0 8px 0;">Top Categories</h4>
          <table style="width: 100%; border-collapse: collapse;">
            ${topCategoryRows}
          </table>
        </div>`;
    })
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Monthly Budget Summary</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">Here is your monthly budget summary for the period that just closed:</p>

      ${budgetSections}

      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">View Budget Dashboard</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function passwordResetTemplate(
  firstName: string,
  resetUrl: string,
): string {
  const safeName = escapeHtml(firstName || "there");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Password Reset Request</h2>
      <p style="color: #374151;">Hi ${safeName},</p>
      <p style="color: #374151;">We received a request to reset your password. Click the button below to set a new password:</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">Reset Password</a>
      </p>
      <p style="color: #374151;">This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}
