import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import {
  ATTACHMENT_EXTENSIONS_BY_MIME,
  SHARE_ATTACHMENT_EXTENSIONS,
  SHARE_CACHE_NAME,
  SHARE_KEY_PREFIX,
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  SHARE_NAME_HEADER,
  SHARE_PAGE_PATH,
  SHARE_STASH_TTL_MS,
  SHARE_STATEMENT_EXTENSIONS,
  SHARE_STATEMENT_MIME_TYPES,
  SHARE_TARGET_FILES_FIELD,
  SHARE_TARGET_PATH,
  classifySharedFile,
} from '@/lib/share-target';
import { ACCEPTED_ATTACHMENT_TYPES } from '@/types/attachment';

// The service worker is a classic script with no exports, so it is exercised the
// way the browser runs it: evaluated in a sandbox that captures its listeners,
// then driven through fake fetch and activate events.
//
// What these tests are really about is a POST nobody in the app can see. The OS
// hands the worker files directly, so the worker is the only place the limits,
// the refusal reasons and the redirect can be checked at all -- and the only
// place that can promise a share never ends on a browser error page.

const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

const ORIGIN = 'https://monize.test';

interface SharedInput {
  name: string;
  type: string;
  size?: number;
  body?: string;
}

function loadServiceWorker(options: { now?: number } = {}) {
  const listeners: Record<string, ((event: unknown) => unknown)[]> = {};
  const stores = new Map<string, Map<string, Response>>();
  let uuidCounter = 0;

  const absolute = (key: string) =>
    new URL(typeof key === 'string' ? key : String(key), ORIGIN).toString();

  const order: string[] = [];

  const makeCache = (store: Map<string, Response>, name: string) => ({
    keys: async () => {
      order.push(`keys:${name}`);
      return [...store.keys()].map((url) => ({ url }));
    },
    match: async (key: string | { url: string }) => {
      const hit = store.get(absolute(typeof key === 'string' ? key : key.url));
      return hit ? hit.clone() : undefined;
    },
    put: async (key: string | { url: string }, response: Response) => {
      store.set(absolute(typeof key === 'string' ? key : key.url), response);
    },
    delete: async (key: string | { url: string }) =>
      store.delete(absolute(typeof key === 'string' ? key : key.url)),
  });

  const caches = {
    open: async (name: string) => {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      return makeCache(store, name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async () => undefined,
  };

  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: unknown) => unknown) => {
        (listeners[type] ??= []).push(fn);
      },
      skipWaiting: vi.fn(),
      location: { origin: ORIGIN },
      registration: { showNotification: vi.fn() },
      clients: {
        claim: vi.fn(() => {
          order.push('claim');
        }),
        matchAll: async () => [],
      },
      crypto: { randomUUID: () => `bundle-${++uuidCounter}` },
    },
    caches,
    fetch: async () => new Response('', { status: 200 }),
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) =>
      globalThis.clearTimeout(id),
    URL,
    Response,
    TextEncoder,
    Date: options.now
      ? new Proxy(Date, { get: (t, p) => (p === 'now' ? () => options.now! : Reflect.get(t, p)) })
      : Date,
  });
  vm.runInContext(swSource, context);

  /** Read a top-level constant out of the worker, to compare against the app's. */
  const constant = (name: string) => vm.runInContext(name, context);

  const dispatchFetch = async (request: {
    method: string;
    url: string;
    formData?: () => Promise<unknown>;
    mode?: string;
  }): Promise<Response | null> => {
    let responded: Promise<Response> | null = null;
    const event = {
      request,
      respondWith: (value: Promise<Response>) => {
        responded = value;
      },
    };
    for (const listener of listeners.fetch ?? []) listener(event);
    return responded ? await responded : null;
  };

  const dispatchActivate = async () => {
    let pending: Promise<unknown> = Promise.resolve();
    const event = {
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const listener of listeners.activate ?? []) listener(event);
    await pending;
  };

  /** A share POST as the OS sends it: multipart, with files under one field. */
  const shareRequest = (files: SharedInput[], field = SHARE_TARGET_FILES_FIELD) => ({
    method: 'POST',
    url: `${ORIGIN}${SHARE_TARGET_PATH}`,
    mode: 'navigate',
    formData: async () => ({
      getAll: (name: string) =>
        name === field
          ? files.map((file) => ({
              name: file.name,
              type: file.type,
              size: file.size ?? (file.body ?? 'x').length,
              arrayBuffer: async () =>
                new TextEncoder().encode(file.body ?? 'x').buffer,
            }))
          : [],
    }),
  });

  const shareStore = () => stores.get(SHARE_CACHE_NAME) ?? new Map();

  const readIndex = async (id: string) => {
    const response = shareStore().get(
      absolute(`${SHARE_KEY_PREFIX}${id}/index`),
    );
    return response ? await response.clone().json() : null;
  };

  return {
    listeners,
    stores,
    caches,
    order,
    constant,
    dispatchFetch,
    dispatchActivate,
    shareRequest,
    shareStore,
    readIndex,
    absolute,
  };
}

/** The bundle id out of a `/share?id=` redirect. */
function idFromRedirect(response: Response | null): string {
  const location = response?.headers.get('location') ?? '';
  return new URL(location, ORIGIN).searchParams.get('id') ?? '';
}

describe('service worker share-target mirror', () => {
  // sw.js cannot import lib/share-target.ts, so every value it repeats is
  // checked here. Changing one without the other is the failure this catches.
  const sw = loadServiceWorker();

  it('repeats the app\'s paths, keys and field name exactly', () => {
    expect(sw.constant('SHARE_CACHE_NAME')).toBe(SHARE_CACHE_NAME);
    expect(sw.constant('SHARE_TARGET_PATH')).toBe(SHARE_TARGET_PATH);
    expect(sw.constant('SHARE_PAGE_PATH')).toBe(SHARE_PAGE_PATH);
    expect(sw.constant('SHARE_KEY_PREFIX')).toBe(SHARE_KEY_PREFIX);
    expect(sw.constant('SHARE_NAME_HEADER')).toBe(SHARE_NAME_HEADER);
    expect(sw.constant('SHARE_TARGET_FILES_FIELD')).toBe(
      SHARE_TARGET_FILES_FIELD,
    );
  });

  it('repeats the app\'s limits exactly', () => {
    expect(sw.constant('SHARE_MAX_FILE_BYTES')).toBe(SHARE_MAX_FILE_BYTES);
    expect(sw.constant('SHARE_MAX_FILES')).toBe(SHARE_MAX_FILES);
    expect(sw.constant('SHARE_MAX_TOTAL_BYTES')).toBe(SHARE_MAX_TOTAL_BYTES);
    expect(sw.constant('SHARE_STASH_TTL_MS')).toBe(SHARE_STASH_TTL_MS);
  });

  it('repeats the app\'s accept lists exactly', () => {
    expect(sw.constant('SHARE_ATTACHMENT_MIME_TYPES')).toEqual([
      ...ACCEPTED_ATTACHMENT_TYPES,
    ]);
    expect(sw.constant('SHARE_ATTACHMENT_EXTENSIONS')).toEqual([
      ...SHARE_ATTACHMENT_EXTENSIONS,
    ]);
    expect(sw.constant('SHARE_STATEMENT_EXTENSIONS')).toEqual([
      ...SHARE_STATEMENT_EXTENSIONS,
    ]);
    expect(sw.constant('SHARE_STATEMENT_MIME_TYPES')).toEqual([
      ...SHARE_STATEMENT_MIME_TYPES,
    ]);
    // The extension list is derived in the app; pin the derivation here too, so
    // a new attachment MIME cannot reach the manifest while the worker still
    // refuses files carrying it.
    expect(sw.constant('SHARE_ATTACHMENT_EXTENSIONS')).toEqual(
      ACCEPTED_ATTACHMENT_TYPES.flatMap(
        (mime) => [...(ATTACHMENT_EXTENSIONS_BY_MIME[mime] ?? [])],
      ),
    );
  });

  it('classifies exactly as the app does', () => {
    const cases = [
      { name: 'receipt.jpg', type: 'image/jpeg' },
      { name: 'statement.csv', type: 'application/octet-stream' },
      { name: 'export.QFX', type: '' },
      { name: 'download', type: 'text/csv' },
      { name: 'a.csv', type: 'text/csv; charset=utf-8' },
      { name: 'photo.PNG', type: '' },
      { name: 'profile.mny', type: '' },
      { name: 'budget.kmy', type: '' },
      { name: 'budget.xml', type: 'text/xml' },
      { name: 'notes.txt', type: 'text/plain' },
      { name: 'logo.svg', type: 'image/svg+xml' },
    ];
    const classifyInWorker = sw.constant('classifySharedFile') as (
      name: string,
      type: string,
    ) => string | null;

    for (const input of cases) {
      expect([input.name, classifyInWorker(input.name, input.type)]).toEqual([
        input.name,
        classifySharedFile(input),
      ]);
    }
  });
});

describe('service worker share-target handling', () => {
  it('stashes the files and answers 303 to the review page', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([
        { name: 'receipt.png', type: 'image/png', body: 'PNGBYTES' },
        { name: 'january.csv', type: 'text/csv', body: 'date,amount' },
      ]),
    );

    expect(response?.status).toBe(303);
    const id = idFromRedirect(response);
    expect(id).toBe('bundle-1');
    expect(response?.headers.get('location')).toBe(
      `${ORIGIN}${SHARE_PAGE_PATH}?id=bundle-1`,
    );

    const index = await sw.readIndex(id);
    expect(index.files).toHaveLength(2);
    expect(index.files[0]).toMatchObject({
      name: 'receipt.png',
      type: 'image/png',
      kind: 'attachment',
      key: `${SHARE_KEY_PREFIX}${id}/file/0`,
    });
    expect(index.files[1]).toMatchObject({
      name: 'january.csv',
      kind: 'statement',
    });
    expect(typeof index.createdAt).toBe('number');
  });

  it('stores the bytes under an extension-less key, with the name header', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([{ name: 'my receipt.png', type: 'image/png', body: 'DATA' }]),
    );
    const id = idFromRedirect(response);

    const stored = sw
      .shareStore()
      .get(sw.absolute(`${SHARE_KEY_PREFIX}${id}/file/0`));
    expect(stored).toBeDefined();
    expect(await stored!.clone().text()).toBe('DATA');
    expect(stored!.headers.get(SHARE_NAME_HEADER)).toBe(
      encodeURIComponent('my receipt.png'),
    );
    // isStaticAsset matches a trailing extension; a stash key must carry none.
    const key = `${SHARE_KEY_PREFIX}${id}/file/0`;
    expect(key.split('/').pop()).not.toContain('.');
  });

  it('refuses an unsupported file with a reason and stores no bytes for it', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([
        { name: 'profile.mny', type: 'application/octet-stream' },
        { name: 'ok.pdf', type: 'application/pdf' },
      ]),
    );
    const id = idFromRedirect(response);
    const index = await sw.readIndex(id);

    expect(index.files[0]).toMatchObject({ name: 'profile.mny', reason: 'unsupported' });
    expect(index.files[0].key).toBeUndefined();
    expect(
      sw.shareStore().has(sw.absolute(`${SHARE_KEY_PREFIX}${id}/file/0`)),
    ).toBe(false);
    // The supported sibling still lands: one refusal is not a failed share.
    expect(index.files[1].key).toBe(`${SHARE_KEY_PREFIX}${id}/file/1`);
  });

  it('refuses a KMyMoney file like a Money one: the share target takes no import files', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([
        { name: 'budget.kmy', type: 'application/octet-stream' },
        { name: 'budget.xml', type: 'text/xml' },
      ]),
    );
    const index = await sw.readIndex(idFromRedirect(response));

    expect(index.files[0]).toMatchObject({ name: 'budget.kmy', reason: 'unsupported' });
    expect(index.files[0].key).toBeUndefined();
    // An .xml is refused outright, not routed by extension: the worker cannot
    // read it to tell a KMyMoney file from an OFX one, and the share target
    // takes statements by extension only.
    expect(index.files[1]).toMatchObject({ name: 'budget.xml', reason: 'unsupported' });
    expect(index.files[1].key).toBeUndefined();
  });

  it('refuses an oversize file without storing it', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([
        { name: 'huge.pdf', type: 'application/pdf', size: SHARE_MAX_FILE_BYTES + 1 },
        { name: 'edge.pdf', type: 'application/pdf', size: SHARE_MAX_FILE_BYTES },
      ]),
    );
    const id = idFromRedirect(response);
    const index = await sw.readIndex(id);

    expect(index.files[0].reason).toBe('tooLarge');
    expect(
      sw.shareStore().has(sw.absolute(`${SHARE_KEY_PREFIX}${id}/file/0`)),
    ).toBe(false);
    // Exactly at the cap is accepted: the limit is "over", not "at".
    expect(index.files[1].reason).toBeUndefined();
  });

  it('refuses past the file count, and an unsupported file spends no slot', async () => {
    const sw = loadServiceWorker();
    const files: SharedInput[] = [];
    // One unsupported file first: if it consumed a slot, the last accepted file
    // below would be refused and this count would be short.
    files.push({ name: 'notes.txt', type: 'text/plain' });
    for (let i = 0; i < SHARE_MAX_FILES + 1; i += 1) {
      files.push({ name: `receipt-${i}.png`, type: 'image/png' });
    }

    const response = await sw.dispatchFetch(sw.shareRequest(files));
    const index = await sw.readIndex(idFromRedirect(response));

    const accepted = index.files.filter((file: { key?: string }) => file.key);
    expect(accepted).toHaveLength(SHARE_MAX_FILES);
    expect(index.files[0].reason).toBe('unsupported');
    expect(index.files[index.files.length - 1].reason).toBe('tooMany');
  });

  it('refuses once the share exceeds the total byte budget', async () => {
    const sw = loadServiceWorker();
    // Each file is comfortably under the per-file cap and the count cap, so the
    // total budget is the only limit that can be doing the refusing here.
    const each = SHARE_MAX_FILE_BYTES - 1;
    const fits = Math.floor(SHARE_MAX_TOTAL_BYTES / each);
    const files: SharedInput[] = [];
    for (let i = 0; i <= fits; i += 1) {
      files.push({ name: `page-${i}.pdf`, type: 'application/pdf', size: each });
    }
    expect(files.length).toBeLessThanOrEqual(SHARE_MAX_FILES);

    const response = await sw.dispatchFetch(sw.shareRequest(files));
    const index = await sw.readIndex(idFromRedirect(response));

    const reasons = index.files.map((file: { reason?: string }) => file.reason);
    expect(reasons.slice(0, fits)).toEqual(new Array(fits).fill(undefined));
    expect(reasons[fits]).toBe('shareTooLarge');
  });

  it('still lands the user on the review page when the body is malformed', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch({
      method: 'POST',
      url: `${ORIGIN}${SHARE_TARGET_PATH}`,
      formData: async () => {
        throw new TypeError('could not parse body');
      },
    });

    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe(
      `${ORIGIN}${SHARE_PAGE_PATH}?error=stash`,
    );
  });

  it('writes an empty bundle rather than failing when nothing was shared', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(sw.shareRequest([]));
    const index = await sw.readIndex(idFromRedirect(response));

    expect(response?.status).toBe(303);
    expect(index.files).toEqual([]);
  });

  it('ignores files sent under any other field name', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch(
      sw.shareRequest([{ name: 'a.png', type: 'image/png' }], 'somethingElse'),
    );
    const index = await sw.readIndex(idFromRedirect(response));

    expect(index.files).toEqual([]);
  });
});

describe('service worker share-target interception boundary', () => {
  it('leaves a GET of the action path to the network', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch({
      method: 'GET',
      url: `${ORIGIN}${SHARE_TARGET_PATH}`,
      mode: 'cors',
    });

    expect(response).toBeNull();
  });

  it('leaves a POST to any other path to the network', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch({
      method: 'POST',
      url: `${ORIGIN}/api/v1/transactions`,
      mode: 'cors',
    });

    expect(response).toBeNull();
  });

  it('leaves a cross-origin POST to the same path alone', async () => {
    const sw = loadServiceWorker();

    const response = await sw.dispatchFetch({
      method: 'POST',
      url: `https://evil.test${SHARE_TARGET_PATH}`,
      mode: 'cors',
    });

    expect(response).toBeNull();
  });
});

describe('service worker share stash lifetime', () => {
  it('keeps the share cache when a worker update cleans up', async () => {
    const sw = loadServiceWorker();
    await sw.dispatchFetch(
      sw.shareRequest([{ name: 'a.png', type: 'image/png' }]),
    );
    // A cache from an older worker, which activate is entitled to drop.
    await sw.caches.open('monize-static-v2');

    await sw.dispatchActivate();

    expect(await sw.caches.keys()).toContain(SHARE_CACHE_NAME);
    expect(await sw.caches.keys()).not.toContain('monize-static-v2');
    expect(sw.shareStore().size).toBeGreaterThan(0);
  });

  // Taking control of open pages is what the offline fallback and the share
  // target both need; housekeeping must not stand in front of it.
  it('claims clients before it purges, so control is not gated on housekeeping', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchActivate();

    const claimed = sw.order.indexOf('claim');
    const purged = sw.order.indexOf(`keys:${SHARE_CACHE_NAME}`);
    expect(claimed).toBeGreaterThan(-1);
    expect(purged).toBeGreaterThan(-1);
    expect(claimed).toBeLessThan(purged);
  });

  it('purges an expired bundle on activate and keeps a live one', async () => {
    const start = 1_700_000_000_000;
    const sw = loadServiceWorker({ now: start });
    const liveResponse = await sw.dispatchFetch(
      sw.shareRequest([{ name: 'live.png', type: 'image/png' }]),
    );
    const liveId = idFromRedirect(liveResponse);

    // Age one bundle past the lifetime by rewriting its stamp, which is what
    // the passage of time looks like from the cache's point of view.
    const store = sw.shareStore();
    const staleKey = sw.absolute(`${SHARE_KEY_PREFIX}stale/index`);
    store.set(
      staleKey,
      new Response(
        JSON.stringify({
          id: 'stale',
          createdAt: start - SHARE_STASH_TTL_MS - 1,
          files: [],
        }),
      ),
    );
    store.set(sw.absolute(`${SHARE_KEY_PREFIX}stale/file/0`), new Response('x'));

    await sw.dispatchActivate();

    const keys = [...sw.shareStore().keys()];
    expect(keys.some((key) => key.includes('/stale/'))).toBe(false);
    expect(keys.some((key) => key.includes(`/${liveId}/`))).toBe(true);
  });

  it('purges before stashing a new share, so an idle worker still expires one', async () => {
    const start = 1_700_000_000_000;
    const sw = loadServiceWorker({ now: start });
    const store = (await sw.caches.open(SHARE_CACHE_NAME), sw.shareStore());
    store.set(
      sw.absolute(`${SHARE_KEY_PREFIX}stale/index`),
      new Response(
        JSON.stringify({
          id: 'stale',
          createdAt: start - SHARE_STASH_TTL_MS - 1,
          files: [],
        }),
      ),
    );

    await sw.dispatchFetch(
      sw.shareRequest([{ name: 'new.png', type: 'image/png' }]),
    );

    expect([...sw.shareStore().keys()].some((key) => key.includes('/stale/'))).toBe(
      false,
    );
  });
});
