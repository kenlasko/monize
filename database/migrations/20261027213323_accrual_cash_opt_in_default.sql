-- New installations opt into accrual reporting; preserve existing choices and schedules.
ALTER TABLE user_preferences ALTER COLUMN reporting_basis SET DEFAULT 'cash';
