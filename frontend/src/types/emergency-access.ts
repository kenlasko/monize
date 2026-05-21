export interface EmergencyAccessContact {
  id: string;
  firstName: string;
  email: string;
  createdAt: string;
}

export interface EmergencyAccessView {
  emailConfigured: boolean;
  enabled: boolean;
  grantAfterDays: number;
  reminderAfterDays: number;
  message: string | null;
  lastReminderSentAt: string | null;
  grantedAt: string | null;
  lastActivityAt: string | null;
  contacts: EmergencyAccessContact[];
}

export interface UpsertEmergencyAccessSettings {
  enabled: boolean;
  grantAfterDays: number;
  reminderAfterDays: number;
  message?: string | null;
}

export interface UpsertEmergencyAccessContact {
  firstName: string;
  email: string;
}

export interface EmergencyAccessClaimPreview {
  ownerFirstName: string | null;
  ownerLastName: string | null;
  contactFirstName: string;
  message: string | null;
  expiresAt: string;
}
