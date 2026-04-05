-- Change timezone column default from 'UTC' to 'browser' so it matches the
-- application-level default set in users.service.ts. Users who never explicitly
-- chose a timezone still have the old 'UTC' default and should be migrated.

ALTER TABLE user_preferences ALTER COLUMN timezone SET DEFAULT 'browser';

UPDATE user_preferences SET timezone = 'browser' WHERE timezone = 'UTC';
