import { escapeHtml } from "../common/escape-html.util";
import { formatCurrency } from "../common/format-currency.util";
import { EmailT, englishEmailT } from "../i18n/email-translator";

export function testEmailTemplate(
  firstName: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.test.heading", "Monize Test Email")}</h2>
      <p style="color: #374151;">${t("emails.test.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.test.body", "This is a test email from Monize. If you received this, your email notifications are working correctly.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface BillData {
  payee: string;
  amount: number;
  dueDate: string;
  currencyCode: string;
  isIncome: boolean;
}

export function billReminderTemplate(
  firstName: string,
  bills: BillData[],
  appUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const billRows = bills
    .map(
      (b) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(b.payee)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(b.dueDate)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; color: white; background: ${b.isIncome ? "#059669" : "#dc2626"};">${b.isIncome ? t("emails.billReminder.typeIncome", "Income") : t("emails.billReminder.typeExpense", "Expense")}</span>
          </td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: ${b.isIncome ? "#059669" : "#dc2626"}; font-weight: 500;">${formatCurrency(Math.abs(b.amount), b.currencyCode)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.billReminder.heading", "Upcoming Bill Reminder")}</h2>
      <p style="color: #374151;">${t("emails.billReminder.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${bills.length === 1 ? t("emails.billReminder.introOne", "You have 1 upcoming bill that needs attention:") : t("emails.billReminder.introMany", `You have ${bills.length} upcoming bills that need attention:`, { count: bills.length })}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.billReminder.colPayee", "Payee")}</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.billReminder.colDueDate", "Due Date")}</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.billReminder.colType", "Type")}</th>
            <th style="padding: 10px 12px; text-align: right; font-weight: 600; color: #374151;">${t("emails.billReminder.colAmount", "Amount")}</th>
          </tr>
        </thead>
        <tbody>${billRows}</tbody>
      </table>
      <p style="margin-top: 20px;">
        <a href="${appUrl}/bills" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.billReminder.button", "View Bills &amp; Deposits")}</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface MortgageReminderData {
  name: string;
  termEndDate: string;
  daysUntilRenewal: number;
}

export function mortgageReminderTemplate(
  firstName: string,
  mortgages: MortgageReminderData[],
  appUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const mortgageRows = mortgages
    .map(
      (m) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(m.name)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(m.termEndDate)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: ${m.daysUntilRenewal <= 30 ? "#dc2626" : "#d97706"}; font-weight: 500;">${m.daysUntilRenewal === 1 ? t("emails.mortgageReminder.daysRemainingOne", "1 day") : t("emails.mortgageReminder.daysRemainingMany", `${m.daysUntilRenewal} days`, { count: m.daysUntilRenewal })}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.mortgageReminder.heading", "Mortgage Renewal Reminder")}</h2>
      <p style="color: #374151;">${t("emails.mortgageReminder.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${mortgages.length === 1 ? t("emails.mortgageReminder.introOne", "You have 1 mortgage with an upcoming term renewal. Contact your lender to discuss renewal options before the term ends:") : t("emails.mortgageReminder.introMany", `You have ${mortgages.length} mortgages with an upcoming term renewal. Contact your lender to discuss renewal options before the term ends:`, { count: mortgages.length })}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.mortgageReminder.colMortgage", "Mortgage")}</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.mortgageReminder.colTermEndDate", "Term End Date")}</th>
            <th style="padding: 10px 12px; text-align: right; font-weight: 600; color: #374151;">${t("emails.mortgageReminder.colTimeRemaining", "Time Remaining")}</th>
          </tr>
        </thead>
        <tbody>${mortgageRows}</tbody>
      </table>
      <p style="margin-top: 20px;">
        <a href="${appUrl}/accounts" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.mortgageReminder.button", "View Accounts")}</a>
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

function severityLabel(severity: string, t: EmailT = englishEmailT): string {
  switch (severity) {
    case "critical":
      return t("emails.severity.critical", "Critical");
    case "warning":
      return t("emails.severity.warning", "Warning");
    case "success":
      return t("emails.severity.success", "Good News");
    default:
      return t("emails.severity.info", "Info");
  }
}

export function budgetAlertImmediateTemplate(
  firstName: string,
  alerts: BudgetAlertData[],
  appUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const alertRows = alerts
    .map(
      (a) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; color: white; background: ${severityColor(a.severity)};">
              ${escapeHtml(severityLabel(a.severity, t))}
            </span>
          </td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${escapeHtml(a.title)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${escapeHtml(a.message)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.budgetAlertImmediate.heading", "Alert")}</h2>
      <p style="color: #374151;">${t("emails.budgetAlertImmediate.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.budgetAlertImmediate.intro", "Your budget needs attention:")}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.budgetAlertImmediate.colSeverity", "Severity")}</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.budgetAlertImmediate.colAlert", "Alert")}</th>
            <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #374151;">${t("emails.budgetAlertImmediate.colDetails", "Details")}</th>
          </tr>
        </thead>
        <tbody>${alertRows}</tbody>
      </table>
      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.budgetAlertImmediate.button", "View Budget")}</a>
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
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");

  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const warningAlerts = alerts.filter((a) => a.severity === "warning");
  const positiveAlerts = alerts.filter((a) => a.severity === "success");

  const alertSummary: string[] = [];
  if (criticalAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #dc2626; font-weight: 600;">${criticalAlerts.length} ${criticalAlerts.length === 1 ? t("emails.budgetWeeklyDigest.criticalOne", "critical") : t("emails.budgetWeeklyDigest.criticalMany", "critical")}</span>`,
    );
  }
  if (warningAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #d97706; font-weight: 600;">${warningAlerts.length} ${warningAlerts.length === 1 ? t("emails.budgetWeeklyDigest.warningOne", "warning") : t("emails.budgetWeeklyDigest.warningMany", "warnings")}</span>`,
    );
  }
  if (positiveAlerts.length > 0) {
    alertSummary.push(
      `<span style="color: #059669; font-weight: 600;">${positiveAlerts.length} ${positiveAlerts.length === 1 ? t("emails.budgetWeeklyDigest.positiveOne", "positive") : t("emails.budgetWeeklyDigest.positiveMany", "positive")}</span>`,
    );
  }

  const topAlerts = alerts.slice(0, 5);
  const alertRows = topAlerts
    .map(
      (a) =>
        `<li style="margin-bottom: 8px;">
          <span style="display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; color: white; background: ${severityColor(a.severity)}; vertical-align: middle;">
            ${escapeHtml(severityLabel(a.severity, t))}
          </span>
          <span style="color: #374151; margin-left: 4px;">${escapeHtml(a.title)}</span>
        </li>`,
    )
    .join("");

  const safeBudgetNames = budgetNames.map((n) => escapeHtml(n)).join(", ");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.budgetWeeklyDigest.heading", "Weekly Budget Summary")}</h2>
      <p style="color: #374151;">${t("emails.budgetWeeklyDigest.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.budgetWeeklyDigest.intro", `Here is your weekly budget summary for: <strong>${safeBudgetNames}</strong>`, { budgets: safeBudgetNames })}</p>

      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px 0; color: #374151; font-weight: 600;">${t("emails.budgetWeeklyDigest.thisWeek", "This Week:")} ${alertSummary.join(", ") || t("emails.budgetWeeklyDigest.noAlerts", "No alerts")}</p>
        <p style="margin: 0; color: #6b7280; font-size: 14px;">${t("emails.budgetWeeklyDigest.totalAlerts", `Total alerts: ${alerts.length}`, { count: alerts.length })}</p>
      </div>

      ${
        topAlerts.length > 0
          ? `
        <h3 style="color: #374151; font-size: 16px; margin-top: 20px;">${t("emails.budgetWeeklyDigest.topAlertsHeading", "Top Alerts")}</h3>
        <ul style="padding-left: 0; list-style: none;">${alertRows}</ul>
        ${alerts.length > 5 ? `<p style="color: #6b7280; font-size: 14px;">${t("emails.budgetWeeklyDigest.andMore", `...and ${alerts.length - 5} more`, { count: alerts.length - 5 })}</p>` : ""}
      `
          : ""
      }

      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.budgetWeeklyDigest.button", "View Budget Dashboard")}</a>
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
  currencyCode: string;
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
  t: EmailT = englishEmailT,
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
          <h4 style="color: #dc2626; font-size: 14px; margin: 12px 0 8px 0;">${t("emails.budgetMonthlySummary.overBudget", "Over Budget")}</h4>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
            ${s.overBudgetCategories
              .map(
                (c) =>
                  `<tr>
                    <td style="padding: 4px 8px; color: #374151; font-size: 14px;">${escapeHtml(c.categoryName)}</td>
                    <td style="padding: 4px 8px; text-align: right; color: #dc2626; font-size: 14px; font-weight: 600;">${c.percentUsed.toFixed(0)}%</td>
                    <td style="padding: 4px 8px; text-align: right; color: #6b7280; font-size: 14px;">${formatCurrency(c.actual, s.currencyCode)} / ${formatCurrency(c.budgeted, s.currencyCode)}</td>
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
              <td style="padding: 4px 8px; text-align: right; color: #6b7280; font-size: 14px;">${formatCurrency(c.actual, s.currencyCode)} / ${formatCurrency(c.budgeted, s.currencyCode)}</td>
            </tr>`,
        )
        .join("");

      const healthSection =
        s.healthScore !== null
          ? `<p style="margin: 8px 0; color: #374151; font-size: 14px;">
              ${t("emails.budgetMonthlySummary.healthScore", "Health Score:")} <span style="color: ${healthScoreColor(s.healthScore)}; font-weight: 700;">${s.healthScore}/100</span>
              <span style="color: #6b7280;"> (${escapeHtml(s.healthLabel || "")})</span>
            </p>`
          : "";

      return `
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <h3 style="color: #1f2937; font-size: 16px; margin: 0 0 12px 0;">${escapeHtml(s.budgetName)} - ${escapeHtml(s.periodLabel)}</h3>

          <div style="display: flex; gap: 16px; margin-bottom: 12px;">
            <div>
              <span style="color: #6b7280; font-size: 12px;">${t("emails.budgetMonthlySummary.labelBudgeted", "Budgeted")}</span><br/>
              <span style="color: #374151; font-weight: 600;">${formatCurrency(s.totalBudgeted, s.currencyCode)}</span>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 12px;">${t("emails.budgetMonthlySummary.labelSpent", "Spent")}</span><br/>
              <span style="color: ${percentColor}; font-weight: 600;">${formatCurrency(s.totalSpent, s.currencyCode)}</span>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 12px;">${t("emails.budgetMonthlySummary.labelRemaining", "Remaining")}</span><br/>
              <span style="color: ${s.remaining >= 0 ? "#059669" : "#dc2626"}; font-weight: 600;">${formatCurrency(s.remaining, s.currencyCode)}</span>
            </div>
          </div>

          <div style="background: #e5e7eb; border-radius: 4px; height: 8px; margin-bottom: 8px;">
            <div style="background: ${percentColor}; border-radius: 4px; height: 8px; width: ${Math.min(s.percentUsed, 100)}%;"></div>
          </div>
          <p style="margin: 0 0 8px 0; color: ${percentColor}; font-weight: 600; font-size: 14px;">${t("emails.budgetMonthlySummary.percentUsed", `${s.percentUsed.toFixed(1)}% used`, { percent: s.percentUsed.toFixed(1) })}</p>

          ${healthSection}
          ${overBudgetRows}

          <h4 style="color: #374151; font-size: 14px; margin: 12px 0 8px 0;">${t("emails.budgetMonthlySummary.topCategories", "Top Categories")}</h4>
          <table style="width: 100%; border-collapse: collapse;">
            ${topCategoryRows}
          </table>
        </div>`;
    })
    .join("");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.budgetMonthlySummary.heading", "Monthly Budget Summary")}</h2>
      <p style="color: #374151;">${t("emails.budgetMonthlySummary.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.budgetMonthlySummary.intro", "Here is your monthly budget summary for the period that just closed:")}</p>

      ${budgetSections}

      <p style="margin-top: 20px;">
        <a href="${appUrl}/budgets" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.budgetMonthlySummary.button", "View Budget Dashboard")}</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function oidcLinkTemplate(
  firstName: string,
  confirmUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeUrl = escapeHtml(confirmUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.oidcLink.heading", "Link Your SSO Account")}</h2>
      <p style="color: #374151;">${t("emails.oidcLink.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.oidcLink.intro", "Someone attempted to sign in via SSO with an email that matches your existing Monize account. To link your SSO identity to this account, click the button below:")}</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${safeUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">${t("emails.oidcLink.button", "Confirm Account Link")}</a>
      </p>
      <p style="color: #6b7280; font-size: 14px;">${t("emails.oidcLink.disclaimer", "If you did not initiate this request, you can safely ignore this email. The link expires in 1 hour.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function accountLockedTemplate(
  firstName: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.accountLocked.heading", "Account Temporarily Locked")}</h2>
      <p style="color: #374151;">${t("emails.accountLocked.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.accountLocked.body1", "Your Monize account has been temporarily locked due to multiple failed login attempts. This is a security measure to protect your account.")}</p>
      <p style="color: #374151;">${t("emails.accountLocked.body2", "The lock will expire automatically. If you did not attempt to log in, we recommend resetting your password immediately.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function passwordResetTemplate(
  firstName: string,
  resetUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeUrl = escapeHtml(resetUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.passwordReset.heading", "Password Reset Request")}</h2>
      <p style="color: #374151;">${t("emails.passwordReset.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.passwordReset.intro", "We received a request to reset your password. Click the button below to set a new password:")}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.passwordReset.button", "Reset Password")}</a>
      </p>
      <p style="color: #374151;">${t("emails.passwordReset.disclaimer", "This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function emailVerificationTemplate(
  firstName: string,
  verifyUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeUrl = escapeHtml(verifyUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.emailVerification.heading", "Verify your email address")}</h2>
      <p style="color: #374151;">${t("emails.emailVerification.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.emailVerification.intro", "Thanks for signing up for Monize. Please confirm your email address to activate your account and sign in:")}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.emailVerification.button", "Verify Email")}</a>
      </p>
      <p style="color: #374151;">${t("emails.emailVerification.disclaimer", "This link will expire in 24 hours. If you did not create a Monize account, you can safely ignore this email.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function accountInviteTemplate(
  firstName: string,
  inviteUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeUrl = escapeHtml(inviteUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.accountInvite.heading", "Your Monize account is ready")}</h2>
      <p style="color: #374151;">${t("emails.accountInvite.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.accountInvite.intro", "An administrator has created a Monize account for you. Click the button below to set your password and sign in:")}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.accountInvite.button", "Set Your Password")}</a>
      </p>
      <p style="color: #374151;">${t("emails.accountInvite.disclaimer", "This link will expire in 24 hours. If you were not expecting this, you can safely ignore this email.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

export function delegateInviteTemplate(
  firstName: string,
  ownerLabel: string,
  inviteUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeOwner = escapeHtml(ownerLabel);
  const safeUrl = escapeHtml(inviteUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.delegateInvite.heading", "You have been invited to Monize")}</h2>
      <p style="color: #374151;">${t("emails.delegateInvite.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.delegateInvite.intro", `${safeOwner} has invited you to access their Monize account as a delegate. Click the button below to set your password and get started:`, { owner: safeOwner })}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.delegateInvite.button", "Set Your Password")}</a>
      </p>
      <p style="color: #374151;">${t("emails.delegateInvite.disclaimer", "This link will expire in 24 hours. If you were not expecting this invitation, you can safely ignore this email.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface EmergencyAccessReminderData {
  ownerFirstName: string;
  daysSinceLogin: number;
  daysUntilGrant: number;
  contacts: { firstName: string; email: string }[];
  appUrl: string;
}

export function emergencyAccessReminderTemplate(
  data: EmergencyAccessReminderData,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(data.ownerFirstName || "there");
  const contactRows = data.contacts
    .map(
      (c) =>
        `<li style="color: #374151; padding: 2px 0;">${escapeHtml(c.firstName)} &lt;${escapeHtml(c.email)}&gt;</li>`,
    )
    .join("");
  const grantPhrase =
    data.daysUntilGrant <= 0
      ? t("emails.emergencyAccessReminder.grantPhraseToday", "today")
      : data.daysUntilGrant === 1
        ? t("emails.emergencyAccessReminder.grantPhraseFutureOne", "in 1 day")
        : t(
            "emails.emergencyAccessReminder.grantPhraseFutureMany",
            `in ${data.daysUntilGrant} days`,
            { count: data.daysUntilGrant },
          );
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #b45309;">${t("emails.emergencyAccessReminder.heading", "Monize Emergency Access Reminder")}</h2>
      <p style="color: #374151;">${t("emails.emergencyAccessReminder.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${data.daysSinceLogin === 1 ? t("emails.emergencyAccessReminder.bodyOne", `You have not signed in to Monize for <strong>1 day</strong>. If you remain inactive, your designated emergency contacts will be granted full access to your account ${grantPhrase}.`, { grantPhrase }) : t("emails.emergencyAccessReminder.bodyMany", `You have not signed in to Monize for <strong>${data.daysSinceLogin} days</strong>. If you remain inactive, your designated emergency contacts will be granted full access to your account ${grantPhrase}.`, { daysSinceLogin: data.daysSinceLogin, grantPhrase })}</p>
      <p style="color: #374151;">${t("emails.emergencyAccessReminder.contactsLabel", "Designated contacts:")}</p>
      <ul style="margin: 8px 0 16px 20px; padding: 0;">${contactRows}</ul>
      <p style="margin: 24px 0;">
        <a href="${data.appUrl}/login" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.emergencyAccessReminder.button", "Sign in now")}</a>
      </p>
      <p style="color: #374151;">${t("emails.emergencyAccessReminder.footer", "Signing in resets the timer. If you no longer want this feature enabled, you can disable it from Settings → Emergency Access.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface EmergencyAccessGrantData {
  contactFirstName: string;
  ownerFullName: string;
  message: string | null;
  claimUrl: string;
  expiresAt: Date;
}

export function emergencyAccessGrantTemplate(
  data: EmergencyAccessGrantData,
  t: EmailT = englishEmailT,
): string {
  const safeContact = escapeHtml(data.contactFirstName || "there");
  const safeOwner = escapeHtml(data.ownerFullName || "the account owner");
  const safeUrl = escapeHtml(data.claimUrl);
  const expiry = data.expiresAt.toISOString().split("T")[0];
  const messageBlock = data.message
    ? `<div style="background: #f9fafb; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 16px 0; color: #374151; white-space: pre-wrap; font-size: 14px;">${escapeHtml(data.message).replace(/\n/g, "<br>")}</div>`
    : "";
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.emergencyAccessGrant.heading", "Emergency Access Granted")}</h2>
      <p style="color: #374151;">${t("emails.emergencyAccessGrant.greeting", `Hi ${safeContact},`, { name: safeContact })}</p>
      <p style="color: #374151;">${t("emails.emergencyAccessGrant.body", `<strong>${safeOwner}</strong> previously designated you as an emergency contact on their Monize account. Because they have not signed in for an extended period, you are now being granted full access to take over the account.`, { owner: safeOwner })}</p>
      ${messageBlock}
      <p style="color: #374151;">${t("emails.emergencyAccessGrant.claimIntro", "To claim access, click the link below and set a new password. You will be signed in as the account holder.")}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.emergencyAccessGrant.button", "Claim Emergency Access")}</a>
      </p>
      <p style="color: #374151; font-size: 14px;">${t("emails.emergencyAccessGrant.expiry", `This link is valid until <strong>${expiry}</strong> and can only be used once. If multiple contacts received this email, the first to claim will take over the account.`, { expiry })}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

interface EmergencyAccessGrantRevokedData {
  ownerFirstName: string;
  appUrl: string;
}

export function emergencyAccessGrantRevokedTemplate(
  data: EmergencyAccessGrantRevokedData,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(data.ownerFirstName || "there");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #b45309;">${t("emails.emergencyAccessGrantRevoked.heading", "Emergency Access Was Granted While You Were Away")}</h2>
      <p style="color: #374151;">${t("emails.emergencyAccessGrantRevoked.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.emergencyAccessGrantRevoked.body1", "Because your account had been inactive, your designated emergency contacts were sent links to take over your account. You have now signed back in, so <strong>those links have been revoked</strong> and the safeguard has been re-armed.")}</p>
      <p style="color: #374151;">${t("emails.emergencyAccessGrantRevoked.body2", "If this was expected, no action is needed. If you did not expect this, review your sign-in activity and your emergency-access settings.")}</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(data.appUrl)}/settings/emergency-access" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.emergencyAccessGrantRevoked.button", "Review Emergency Access")}</a>
      </p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}
