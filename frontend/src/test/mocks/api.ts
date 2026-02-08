import { http, HttpResponse } from 'msw';

export const authHandlers = [
  http.get('/api/v1/auth/methods', () => {
    return HttpResponse.json({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false,
    });
  }),

  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.email === 'test@example.com' && body.password === 'TestPassword123!') {
      return HttpResponse.json({
        user: {
          id: 'test-user-id',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          authProvider: 'local',
          hasPassword: true,
          role: 'user',
          isActive: true,
          mustChangePassword: false,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      });
    }
    return new HttpResponse(null, { status: 401 });
  }),

  http.get('/api/v1/auth/profile', () => {
    return HttpResponse.json({
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      authProvider: 'local',
      hasPassword: true,
      role: 'user',
      isActive: true,
      mustChangePassword: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  }),
];

export const accountHandlers = [
  http.get('/api/v1/accounts', () => {
    return HttpResponse.json([
      {
        id: 'account-1',
        name: 'Checking',
        accountType: 'CHEQUING',
        currencyCode: 'USD',
        currentBalance: 1500.0,
        openingBalance: 1000.0,
        isClosed: false,
        canDelete: false,
      },
    ]);
  }),
];

export const allHandlers = [...authHandlers, ...accountHandlers];
