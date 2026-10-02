/** English fallbacks for notification email copy; kept in parity with the catalog by tests. */
export const NOTIFICATION_EMAIL_MESSAGES = {
  "priceMovement.title": "Price change alert: {{ symbol }} ({{ percent }}%)",
  "priceMovement.message":
    "{{ symbol }}: {{ percent }}% compared with the previous available session.",
  "billDue.titleOverdue": "{{ payee }} overdue",
  "billDue.titleToday": "{{ payee }} due today",
  "billDue.titleTomorrow": "{{ payee }} due tomorrow",
  "billDue.titleInDays": "{{ payee }} due in {{ days }} days",
  "billDue.amountDue": "{{ amount }} due on {{ date }}",
  "billDue.amountUnavailable":
    "Amount unavailable (no current exchange rate), due on {{ date }}",
  "gemSignal.riskTitle": "{{ strategy }} switched to {{ state }}",
  "gemSignal.riskMessage":
    'Your GEM strategy "{{ strategy }}" changed from {{ fromState }} to {{ toState }}. Open to review the recommendation.',
  "gemSignal.allocationTitle": "{{ strategy }} changed its target",
  "gemSignal.allocationMessage":
    'Your GEM strategy "{{ strategy }}" now targets {{ target }}. Open to review the recommendation.',
  "gemSignal.riskOn": "risk-on",
  "gemSignal.riskOff": "risk-off",
  "gemSignal.roles.US_EQUITY": "S&P 500",
  "gemSignal.roles.EX_US_EQUITY": "Developed markets ex-US",
  "gemSignal.roles.EM_EQUITY": "Emerging markets",
  "gemSignal.roles.SAFE": "Safe asset",
  "gemSignal.roles.RISK_FREE": "Risk-free benchmark",
  "gemSignal.allocationMessageUnknown":
    'Your GEM strategy "{{ strategy }}" changed its target. Open to review the recommendation.',
  "bankSync.expiringTitleToday": "{{ institution }}: bank access ends today",
  "bankSync.expiringTitleOneDay":
    "{{ institution }}: bank access ends within 1 day",
  "bankSync.expiringTitleDays":
    "{{ institution }}: bank access ends within {{ days }} days",
  "bankSync.expiringMessage":
    "Your consent for Monize to read {{ institution }} ends on {{ date }}. Renew the connection in Monize to keep syncing.",
  "bankSync.expiredTitle": "{{ institution }}: bank access has ended",
  "bankSync.expiredMessage":
    "Your consent for Monize to read {{ institution }} has ended. Renew the connection in Monize to resume syncing.",
  "bankSync.failedTitle": "{{ institution }}: sync failed",
  "bankSync.failedMessage":
    "The daily sync of {{ institution }} failed for: {{ accounts }}. Open bank sync settings to see why.",
  "bankSync.failedCredentialsMessage":
    "The daily sync of {{ institution }} could not start because the bank sync credentials are missing or were rejected. Check them in bank sync settings.",
  "bankSync.unnamedAccount": "an account",
  "bankSync.importedTitle": "{{ institution }}: new transactions imported",
  "bankSync.importedMessage":
    "Transactions imported from {{ institution }} by the daily sync: {{ imported }}.",
  "bankSync.importedNoneTitle": "{{ institution }}: no new transactions",
  "bankSync.importedNoneMessage":
    "The daily sync of {{ institution }} found no new transactions.",
  "portfolioMovement.titleUp": "Investments up {{ percent }}%",
  "portfolioMovement.titleDown": "Investments down {{ percent }}%",
  "portfolioMovement.messageUp":
    "Your investments are up {{ percent }}% from {{ from }} to {{ to }}, excluding deposits and withdrawals. Open to review.",
  "portfolioMovement.messageDown":
    "Your investments are down {{ percent }}% from {{ from }} to {{ to }}, excluding deposits and withdrawals. Open to review.",
  "balanceThreshold.titleLow": "{{ account }} is below your threshold",
  "balanceThreshold.titleHigh": "{{ account }} is above your threshold",
  "balanceThreshold.messageLow":
    "{{ account }} dropped to {{ balance }}, below your {{ threshold }} threshold.",
  "balanceThreshold.messageHigh":
    "{{ account }} rose to {{ balance }}, above your {{ threshold }} threshold.",
  "system.backupFailed.title": "Automatic backup failed",
  "system.backupFailed.message":
    "The automatic backup for {{ user }} failed: {{ error }}",
  "system.backupPartial.title": "Automatic backup incomplete",
  "system.backupPartial.messageAttachments":
    "The backup for {{ user }} was written, but {{ missing }} of {{ expected }} attachments could not be included and {{ inconsistent }} did not match their metadata. Complete backups were preserved.",
  "system.backupPartial.messagePromotion":
    "The daily backup for {{ user }} succeeded, but its weekly or monthly copy could not be written: {{ error }}",
  "system.backupPartial.messageRetention":
    "The backup for {{ user }} succeeded, but old backup files could not be cleaned up: {{ error }}",
  "system.encryptionKeyMissing.title": "Encryption key not configured",
  "system.encryptionKeyMissing.message":
    "ENCRYPTION_KEY is not set, so backups are written unencrypted and secrets cannot be stored. A future release will refuse to start without it.",
  "system.jwtSecretWeak.title": "JWT_SECRET is weak",
  "system.jwtSecretWeak.message":
    "JWT_SECRET is a published placeholder or too predictable, so session tokens can be forged. Generate a strong one (openssl rand -base64 32). Changing it stops authenticator codes from working and forgets trusted devices: users sign in with a backup code and set up 2FA again, and you reset 2FA in User Management for anyone without one. See docs/backend/modules-and-runtime.md (Changing JWT_SECRET) first.",
  "system.smtpFailure.title": "Email delivery is failing",
  "system.smtpFailure.message":
    "Monize could not send email: {{ error }}. Notifications and reminders are not being delivered.",
  "system.providerOutage.title": "{{ provider }} is not responding",
  "system.providerOutage.message":
    "Market data from {{ provider }} is unavailable. Prices and index data may be out of date until it answers again.",
  "system.providerRecovered.title": "{{ provider }} is answering again",
  "system.providerRecovered.message":
    "The outage is over and market data from {{ provider }} is updating again.",
  "system.scheduledPostFailed.title": "{{ name }} could not be posted",
  "system.scheduledPostFailed.message":
    "Your scheduled transaction due {{ date }} did not post automatically: {{ error }}. You can post it manually from Bills.",
  "budget.overTitle": "{{ category }} is over budget",
  "budget.overMessage":
    "You have spent {{ amount }} of your {{ limit }} budget for {{ category }} ({{ percent }}%).",
  "budget.criticalTitle": "{{ category }} approaching limit",
  "budget.warningTitle": "{{ category }} reaching budget limit",
  "budget.thresholdMessage":
    "You have used {{ percent }}% of your {{ category }} budget ({{ amount }} of {{ limit }}).",
  "budget.projectedTitle": "{{ category }} projected to overspend",
  "budget.projectedMessage":
    "At your current pace, {{ category }} is projected to reach {{ projected }} by the end of the period (budget: {{ budgeted }}).",
  "budget.flexTitle": 'Flex group "{{ group }}" at {{ percent }}%',
  "budget.flexMessage":
    'The "{{ group }}" flex group has used {{ spent }} of its combined {{ budgeted }} budget ({{ percent }}%).',
  "budget.incomeTitle": "Income below expected",
  "budget.incomeMessage":
    "Your actual income ({{ actual }}) is at {{ ratio }}% of expected income ({{ expected }}) at this point in the period.",
  "budget.milestoneTitle": "Budget on track",
  "budget.milestoneMessage":
    "You are {{ progress }}% through the period and have only used {{ percent }}% of your total budget. Keep it up!",
  "budget.seasonalTitle": "Seasonal spike expected for {{ category }}",
  "budget.seasonalMessage":
    "Last {{ month }} you spent {{ increase }}x your usual on {{ category }}. Consider adjusting your budget.",
} as const;
