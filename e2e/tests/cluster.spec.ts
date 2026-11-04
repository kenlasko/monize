import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  csrfToken,
  createApiClient,
  registerViaApi,
  uniqueId,
} from '../helpers/api';
import { E2E_DEFAULT_PASSWORD } from '../helpers/credentials';

/**
 * The `CLUSTER_MODE=multi` proof: the app answered by two interchangeable
 * backend replicas behind a load balancer with NO affinity at all.
 *
 * Everything else in this suite runs against one backend, where a counter in a
 * `Map` and a counter in a row behave identically -- which is exactly why the
 * horizontal-scaling defects were invisible for so long
 * (`docs/specs/horizontal-scaling.md`). These tests are the only place
 * in the repository where a second replica actually answers a browser, so they
 * are the only place a regression to process-local state shows up as a failing
 * user-visible outcome rather than as an integration test about a table.
 *
 * Run only against the two-replica stack (`docker-compose.e2e.yml`, profile
 * `cluster`), through the `cluster` project, which `playwright.config.ts`
 * defines only when `E2E_CLUSTER=multi`. The chromium and firefox projects
 * ignore this file: against one backend every assertion below is true for the
 * wrong reason.
 */
test.describe('CLUSTER_MODE=multi', () => {

  /** The LB's own address, for the checks that read nginx directly. */
  const LB_URL = process.env.E2E_LB_URL || 'http://localhost:3002';

  /**
   * Which replica answered, as `api-lb.conf` labels it. Absent means the
   * response never went through the load balancer, which makes every
   * distribution assertion below meaningless rather than merely failing -- so
   * the callers assert on the set, and an empty set fails loudly.
   */
  const servedBy = (headers: Record<string, string>): string | undefined =>
    headers['x-e2e-upstream'];

  /**
   * Repeat `send` until the answers have come from more than one replica, up
   * to `max` attempts. Round-robin makes two enough in principle; the loop
   * exists because the frontend proxy holds a connection pool and a retry in
   * the app could take a turn, and a fixed count that is occasionally one short
   * is a flake rather than a finding.
   */
  async function collectUpstreams(
    send: () => Promise<{ ok: boolean; upstream?: string }>,
    max = 12,
  ): Promise<Set<string>> {
    const seen = new Set<string>();
    for (let i = 0; i < max; i++) {
      const { ok, upstream } = await send();
      expect(ok, `request ${i + 1} through the load balancer failed`).toBe(
        true,
      );
      if (upstream) seen.add(upstream);
      if (seen.size > 1) break;
    }
    return seen;
  }

  test('serves one browser session from both replicas', async ({ request }) => {
    await registerViaApi(request);

    // The session is cookies plus a CSRF token derived from JWT_SECRET
    // (`derivePurposeKey`). Both replicas derive it from the same secret, so
    // one session is valid on either -- a per-process key would 401 or 403 the
    // moment the next request landed elsewhere.
    const seen = await collectUpstreams(async () => {
      const res = await request.get('/api/v1/auth/profile');
      return { ok: res.ok(), upstream: servedBy(res.headers()) };
    });

    expect(
      seen.size,
      `the app's own requests were answered by ${[...seen].join(', ') || 'no labelled replica'}; ` +
        'the cluster stack should spread them over two',
    ).toBeGreaterThan(1);
  });

  test('reports its wake-up channel on every replica', async ({ request }) => {
    // Half of INV-HA-001: a replica in `multi` holds one dedicated LISTEN
    // connection, /health reports its state, and /health/ready reads it. The
    // key is present ONLY in multi -- in single there is no cross-replica
    // channel and a key that is always "healthy" would invite a dashboard to
    // watch a constant -- so its presence is itself the assertion that both
    // replicas really booted in the mode this shard claims.
    const seen = new Set<string>();
    for (let i = 0; i < 8 && seen.size < 2; i++) {
      const res = await request.get('/api/v1/health');
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        status: string;
        checks: { database: string; eventBus?: string };
      };
      expect(body.checks.database).toBe('healthy');
      expect(
        body.checks.eventBus,
        'a replica in multi must report its notification channel',
      ).toBe('healthy');
      expect(body.status).toBe('ok');
      const upstream = servedBy(res.headers());
      if (upstream) seen.add(upstream);
    }
    expect(seen.size).toBeGreaterThan(1);

    // Readiness, with what it does and does not say. `/api/v1/health/ready` is
    // the one API path the frontend does NOT proxy -- its own route handler
    // fetches the backend itself -- so this reaches a replica through the load
    // balancer and comes back unlabelled. It proves one replica ready, not both.
    const ready = await request.get('/api/v1/health/ready');
    expect(ready.status()).toBe(200);
  });

  test('publishes one OIDC signing key set from either replica', async ({
    request,
  }) => {
    // INV-HA-004. Before the keys were a row, `oidc-provider` invented a
    // development key per process: /oauth/jwks differed per replica and per
    // restart, so an ID token signed by one replica did not verify against the
    // document served by another. This is that defect as a user-visible check.
    const keySets: string[] = [];
    const seen = await collectUpstreams(async () => {
      const res = await request.get('/oauth/jwks');
      if (res.ok()) {
        const body = (await res.json()) as { keys: Array<{ kid: string }> };
        keySets.push(
          body.keys
            .map((k) => k.kid)
            .sort()
            .join(','),
        );
      }
      return { ok: res.ok(), upstream: servedBy(res.headers()) };
    });

    expect(seen.size, 'JWKS was served by only one replica').toBeGreaterThan(1);
    expect(keySets.length).toBeGreaterThan(1);
    expect(
      new Set(keySets).size,
      `replicas published different key sets: ${[...new Set(keySets)].join(' | ')}`,
    ).toBe(1);
    expect(keySets[0]).not.toBe('');
  });

  test('counts one login lockout for the deployment, not one per replica', async ({
    request,
  }) => {
    // The attempt budget is five (`AuthService.MAX_FAILED_ATTEMPTS`), counted
    // by one guarded UPDATE on the user's row. Spread over two replicas a
    // per-process counter would give the attacker ten, and the sixth attempt
    // here would be answered "invalid credentials" instead of "locked".
    const user = await registerViaApi(request);
    const attempts: Array<string | undefined> = [];

    for (let i = 0; i < 5; i++) {
      const res = await request.post('/api/v1/auth/login', {
        data: { email: user.email, password: 'WrongPassword123!' },
      });
      expect(res.status(), `failed attempt ${i + 1} should be refused`).toBe(
        401,
      );
      attempts.push(servedBy(res.headers()));
    }

    const replicas = new Set(attempts.filter(Boolean) as string[]);
    expect(
      replicas.size,
      `all five attempts were served by ${[...replicas].join(', ') || 'no labelled replica'}; ` +
        'the budget is only proven shared when they are spread',
    ).toBeGreaterThan(1);

    // The right password, now. A shared counter has already locked the
    // account; a per-replica one would let this through.
    const afterLock = await request.post('/api/v1/auth/login', {
      data: { email: user.email, password: E2E_DEFAULT_PASSWORD },
    });
    // 403 is the lockout on this route and 401 is "invalid credentials", so
    // the status alone says which happened -- and it says it in every locale,
    // which the message does not.
    expect(
      afterLock.status(),
      `the correct password was accepted after five failures: ${await afterLock.text()}`,
    ).toBe(403);
  });

  test('relays a prompt to an agent on another replica and back', async ({
    request,
    playwright,
  }) => {
    // INV-HA-005 end to end. Three requests make one relay turn -- the
    // browser's SSE stream, the agent's long poll, and the agent's answer --
    // and under round-robin they land on different replicas. Before the queue
    // was a table those three held promises in one process's `Map`s, so this
    // turn could only complete when all three happened to hit the same pod.
    const user = await registerViaApi(request);
    const api = createApiClient(request);
    // Minting a PAT is step-up protected: prove the password again first.
    const stepUp = await api.post<{ stepUpToken: string }>('/auth/step-up', {
      purpose: 'personal-access-token',
      password: user.password,
    });
    const created = await request.post('/api/v1/auth/tokens', {
      headers: {
        'X-CSRF-Token': (await csrfToken(request)) ?? '',
        'X-Step-Up-Token': stepUp.stepUpToken,
      },
      data: { name: `cluster-agent-${uniqueId()}`, scopes: 'read' },
    });
    expect(
      created.ok(),
      `creating the PAT failed (${created.status()}): ${await created.text()}`,
    ).toBeTruthy();
    const pat = (await created.json()) as { token: string };

    // A genuinely separate client: its own context, no session cookies, a
    // bearer token. That is what an MCP agent is.
    const agent = await playwright.request.newContext({
      baseURL: process.env.BASE_URL || 'http://localhost:3001',
    });
    const upstreams = new Set<string>();
    const answer = `relayed-${uniqueId()}`;

    try {
      // The browser's half. Not awaited: the stream stays open until the agent
      // answers it, which is the next thing this test does.
      const token = await csrfToken(request);
      const stream = request.post('/api/v1/ai/relay/query/stream', {
        headers: token ? { 'X-CSRF-Token': token } : {},
        data: { query: 'What is my balance?' },
        timeout: 120_000,
      });

      // The agent's half. `get_next_prompt` parks for up to 25s per call and
      // is woken early by the event bus, which in `multi` is a NOTIFY from
      // whichever replica took the prompt.
      let promptId: string | undefined;
      for (let i = 0; i < 8 && !promptId; i++) {
        const claimed = await mcpCall(agent, pat.token, 'get_next_prompt', {});
        upstreams.add(claimed.upstream ?? '');
        promptId = claimed.structured.hasPrompt
          ? (claimed.structured.promptId as string)
          : undefined;
      }
      expect(promptId, 'the agent never received the queued prompt').toBeTruthy();

      const posted = await mcpCall(agent, pat.token, 'post_response', {
        promptId,
        text: answer,
      });
      upstreams.add(posted.upstream ?? '');
      expect(posted.structured.delivered).toBe(true);

      const body = await (await stream).text();
      expect(
        body,
        'the answer never reached the browser stream',
      ).toContain(answer);
    } finally {
      await agent.dispose();
    }

    upstreams.delete('');
    expect(
      upstreams.size,
      `the agent's calls were all served by ${[...upstreams].join(', ') || 'no labelled replica'}`,
    ).toBeGreaterThan(0);
  });

  test('round-robins at the load balancer itself', async ({ request }) => {
    // The same claim as the first test, read one hop earlier. When the app
    // path fails to show two replicas this says whether the fixture or the
    // header plumbing through the frontend proxy is at fault.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = await request.get(`${LB_URL}/api/v1/health`);
      expect(res.ok()).toBe(true);
      const upstream = servedBy(res.headers());
      if (upstream) seen.add(upstream);
    }
    expect([...seen].length).toBeGreaterThan(1);
  });
});

/**
 * One 2026-07-28 MCP tool call, hand-built.
 *
 * The revision is a plain JSON-RPC POST -- no session, no `initialize`, a fresh
 * server per request -- so an agent needs no SDK here, and adding one as an E2E
 * dependency to make three calls would be the tail wagging the dog. The two
 * `_meta` envelope keys, the `Mcp-Method`/`Mcp-Name` routing headers and the
 * `MCP-Protocol-Version` header naming the same revision as the envelope are
 * what the transport validates; `docs/backend/mcp.md` describes the same wire,
 * and `mcp-eras.spec.ts` drives it through the real SDK.
 *
 * The stateless leg is also the only one that can be used here at all: a
 * 2025-era session is pinned to the replica that created it
 * (`docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`), so
 * a round-robin LB would answer its second request `404 Session not found`.
 */
let nextRpcId = 1;
const MCP_PROTOCOL_VERSION = '2026-07-28';

async function mcpCall(
  agent: APIRequestContext,
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; upstream?: string }> {
  const res = await agent.post('/api/v1/mcp', {
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    data: {
      jsonrpc: '2.0',
      id: nextRpcId++,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    // Longer than the 25s the agent's poll parks for.
    timeout: 60_000,
  });
  const text = await res.text();
  expect(res.ok(), `MCP ${name} -> ${res.status()}: ${text}`).toBe(true);
  // The handler answers JSON here; an SSE framing would put the payload on a
  // `data:` line, so read that shape too rather than depending on the default.
  const payload = text.startsWith('{')
    ? text
    : (text.match(/^data: (.*)$/m)?.[1] ?? text);
  const parsed = JSON.parse(payload) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { message?: string };
  };
  expect(parsed.error, `MCP ${name} returned an error`).toBeUndefined();
  return {
    structured: parsed.result?.structuredContent ?? {},
    upstream: res.headers()['x-e2e-upstream'],
  };
}
