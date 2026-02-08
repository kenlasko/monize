export function testEmailTemplate(firstName: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">MoneyMate Test Email</h2>
      <p style="color: #374151;">Hi ${firstName || 'there'},</p>
      <p style="color: #374151;">This is a test email from MoneyMate. If you received this, your email notifications are working correctly.</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- MoneyMate</p>
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
  const billRows = bills
    .map(
      (b) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${b.payee}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb;">${b.dueDate}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${b.currencyCode} ${Math.abs(b.amount).toFixed(2)}</td>
        </tr>`,
    )
    .join('');

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Upcoming Bill Reminder</h2>
      <p style="color: #374151;">Hi ${firstName || 'there'},</p>
      <p style="color: #374151;">You have ${bills.length} upcoming bill${bills.length === 1 ? '' : 's'} that need${bills.length === 1 ? 's' : ''} attention:</p>
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
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- MoneyMate</p>
    </div>
  `;
}

export function passwordResetTemplate(
  firstName: string,
  resetUrl: string,
): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">Password Reset Request</h2>
      <p style="color: #374151;">Hi ${firstName || 'there'},</p>
      <p style="color: #374151;">We received a request to reset your password. Click the button below to set a new password:</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">Reset Password</a>
      </p>
      <p style="color: #374151;">This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- MoneyMate</p>
    </div>
  `;
}
