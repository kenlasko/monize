import { APIRequestContext, expect } from '@playwright/test';
import { randomBytes } from 'crypto';

const API_PREFIX = '/api/v1';

/** Short, collision-resistant suffix for unique test data. */
export const uniqueId = (): string =>
  Date.now().toString(36) + randomBytes(3).toString('hex');

export interface TestUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

function withPrefix(path: string): string {
  if (path.startsWith('http') || path.startsWith('/api/')) return path;
  return `${API_PREFIX}${path.startsWith('/') ? '' : '/'}${path}`;
}

// The csrf_token cookie is intentionally JS-readable (double-submit pattern);
// resource mutations must echo it back in the X-CSRF-Token header.
async function csrfToken(request: APIRequestContext): Promise<string | undefined> {
  const { cookies } = await request.storageState();
  return cookies.find((c) => c.name === 'csrf_token')?.value;
}

// Register a fresh user via the API. /auth/register is CSRF-exempt and sets the
// auth + csrf cookies on the shared context, so the browser page is logged in
// too. Password meets the 12+ char upper/lower/digit/special policy.
export async function registerViaApi(
  request: APIRequestContext,
  opts: Partial<TestUser> = {},
): Promise<TestUser> {
  const user: TestUser = {
    email: opts.email ?? `e2e-${uniqueId()}@test.example.com`,
    password: opts.password ?? 'E2eTestPass123!',
    firstName: opts.firstName ?? 'E2E',
    lastName: opts.lastName ?? 'Tester',
  };
  const res = await request.post(`${API_PREFIX}/auth/register`, {
    data: {
      email: user.email,
      password: user.password,
      firstName: user.firstName,
      lastName: user.lastName,
    },
  });
  expect(
    res.ok(),
    `register failed (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
  // Guarantee a readable csrf_token cookie is present for later mutations.
  await request.get(`${API_PREFIX}/auth/csrf-refresh`);
  return user;
}

export async function loginViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await request.post(`${API_PREFIX}/auth/login`, {
    data: { email, password },
  });
  expect(res.ok(), `login failed (${res.status()})`).toBeTruthy();
  await request.get(`${API_PREFIX}/auth/csrf-refresh`);
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

// A thin CSRF-aware client over the page's APIRequestContext. Mirrors the
// frontend axios interceptor: inject X-CSRF-Token, and on a 403 CSRF response
// refresh the token once and retry.
export function createApiClient(request: APIRequestContext): ApiClient {
  const send = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ) => {
    const url = withPrefix(path);
    const attempt = async () => {
      const token = await csrfToken(request);
      const headers: Record<string, string> = {};
      if (token) headers['X-CSRF-Token'] = token;
      const opts: { method: string; headers: Record<string, string>; data?: unknown } = {
        method,
        headers,
      };
      if (body !== undefined) opts.data = body;
      return request.fetch(url, opts);
    };
    let res = await attempt();
    if (res.status() === 403) {
      await request.get(`${API_PREFIX}/auth/csrf-refresh`);
      res = await attempt();
    }
    expect(
      res.ok(),
      `${method} ${url} -> ${res.status()}: ${await res.text()}`,
    ).toBeTruthy();
    return res;
  };

  return {
    get: async <T>(path: string): Promise<T> => {
      const res = await send('GET', path);
      return (await res.json()) as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      const res = await send('POST', path, body);
      return (res.status() === 204 ? undefined : await res.json()) as T;
    },
    patch: async <T>(path: string, body?: unknown): Promise<T> => {
      const res = await send('PATCH', path, body);
      return (await res.json()) as T;
    },
    delete: async (path: string): Promise<void> => {
      await send('DELETE', path);
    },
  };
}
