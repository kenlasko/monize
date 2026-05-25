import type { TestUser } from './api';

// Fixed credentials for the admin account. Global setup registers this as the
// very first user (first user => admin role) against the fresh e2e database, so
// no secrets are written to disk -- both global setup and the admin fixture
// import these constants directly.
export const ADMIN_CREDS: TestUser = {
  email: 'e2e-admin@monize.test',
  password: 'E2eAdminPass123!',
  firstName: 'E2E',
  lastName: 'Admin',
};
