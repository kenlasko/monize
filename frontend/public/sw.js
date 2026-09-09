const CACHE_NAME = 'monize-static-v3';

// Synthetic cache key for the localized offline-fallback strings. Populated
// by OfflineFallbackSync (a postMessage handshake from the app), read by
// buildOfflineResponse. Never served to a fetch: it is not a static asset
// and navigations are handled separately.
var OFFLINE_STRINGS_URL = '/__monize/offline-strings';

// How long a navigation may hang before the offline fallback is served.
// Without this, an unreachable or stalled server leaves the installed PWA
// sitting on the OS splash screen with no error UI and no way out except
// force-closing the app.
var NAVIGATION_TIMEOUT_MS = 10000;

// Last-resort copy for a launch that failed before the app ever ran (so no
// handshake has stored localized strings yet). Must mirror
// layout.offlineFallback in src/i18n/messages/en/layout.json.
var OFFLINE_DEFAULT_STRINGS = {
  lang: 'en',
  dir: 'ltr',
  theme: '',
  // The computed page colours of the user's active palette, handshaken from
  // the app; empty until then.
  background: '',
  foreground: '',
  title: 'Unable to connect',
  message: 'Monize could not reach the server. Check your connection and try again.',
  retry: 'Try again',
};

// Stock-palette fallback, used until a handshake has stored the active
// palette's computed colours. Must mirror BOOT_BACKGROUND / BOOT_FOREGROUND
// in src/lib/pwa-theme.ts (asserted by src/test/sw-offline.test.ts).
var OFFLINE_COLORS = {
  light: { background: '#f9fafb', foreground: '#101828' },
  dark: { background: '#101828', foreground: '#f3f4f6' },
};

// The handshaken colours are interpolated into a style block, so only plain
// colour literals are accepted -- anything else falls back to the stock
// palette rather than risking CSS injection through a forged message.
var SAFE_CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9.,%\s/-]*\)|[a-z]{3,20})$/i;

function isSafeCssColor(value) {
  return typeof value === 'string' && value.length <= 40 && SAFE_CSS_COLOR.test(value);
}

const STATIC_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.ico', '.webp',
];

function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith('/_next/static/')) return true;
  return STATIC_EXTENSIONS.some(function (ext) { return pathname.endsWith(ext); });
}

// Install: activate immediately
self.addEventListener('install', function () {
  self.skipWaiting();
});

// Activate: clean up old caches, claim clients
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        // Every cache but the current static one goes, which is also how the
        // retired Web Share Target's 'monize-share-v1' stash leaves a device
        // that already has files sitting in it.
        cacheNames
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      // Taking control of open pages is what the offline fallback depends on.
      return self.clients.claim();
    })
  );
});

// Offline-strings handshake from the app (OfflineFallbackSync).
self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'monize-offline-strings' || !data.payload) return;

  var stored = {};
  Object.keys(OFFLINE_DEFAULT_STRINGS).forEach(function (key) {
    var value = data.payload[key];
    if (typeof value === 'string' && value.length <= 500) {
      stored[key] = value;
    }
  });

  var write = caches.open(CACHE_NAME).then(function (cache) {
    return cache.put(
      OFFLINE_STRINGS_URL,
      new Response(JSON.stringify(stored), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
  if (event.waitUntil) event.waitUntil(write);
});

// ---------------------------------------------------------------------------
// Web Push
//
// The payload is composed by the server and travels through Mozilla's, Google's
// or Apple's infrastructure, so it deliberately carries no amount, account or
// payee -- the detail loads once the app is open. What arrives here is
// { type, title, body, target } and nothing about it is trusted: a worker is the
// last place a forged value can be caught before it becomes a navigation.
// ---------------------------------------------------------------------------

var PUSH_ICON = '/icons/icon-192x192.png';
// The badge is a MASK, not a picture: Chrome on Android keeps only the alpha
// channel and tints what is left, so the alpha has to BE the glyph. Every other
// icon this project ships fails that -- a maskable icon is opaque edge to edge
// by definition of its purpose, which is why the toolbar drew a filled square.
// `badge-monochrome.png` is white-on-transparent, built by
// frontend/scripts/build-notification-badge.mjs and held to that shape by
// src/test/notification-badge.test.ts.
var PUSH_BADGE = '/icons/badge-monochrome.png';
var PUSH_FALLBACK_TITLE = 'Monize';
var PUSH_FALLBACK_BODY = 'You have a new notification in Monize.';

// A push target is a path inside this app, never a URL. Anything else -- an
// absolute URL, a protocol-relative '//host', a backslash Chrome normalises to
// a slash, a 'javascript:' string -- is discarded rather than repaired, because
// a repaired hostile value is still a value somebody chose.
//
// The parser is the authority here, not the shape of the raw string. WHATWG URL
// strips ASCII tab, CR and LF *before* parsing, so '/\t/evil.test/steal' begins
// with a slash, has no second slash, contains no backslash -- and resolves to
// https://evil.test/steal. Any guard written against the characters alone loses
// to that, so the check is: resolve it, then require the result to be this
// origin, and hand back the parser's own normalised path.
function safeNotificationPath(value) {
  if (typeof value !== 'string') return '/';
  if (value.length === 0 || value.length > 512) return '/';
  // Still required, so a target is an absolute path rather than something whose
  // meaning depends on what it is resolved against.
  if (value.charAt(0) !== '/') return '/';

  var resolved;
  try {
    resolved = new URL(value, self.location.origin);
  } catch (_error) {
    return '/';
  }
  if (resolved.origin !== self.location.origin) return '/';
  return resolved.pathname + resolved.search + resolved.hash;
}

/**
 * The key two notifications must share to replace each other.
 *
 * The browser replaces a shown notification whose `tag` matches, so the tag is
 * a claim about what the notification is ABOUT. Two bills due on the same day
 * are both `BILL_DUE`, so grouping by type alone showed the reader one of them
 * and threw the other away.
 *
 * The subject comes from the payload's own `collapseKey`, not from `target`: a
 * route is not a subject, and the bill producer proves it -- every reminder
 * points at `/bills`, because no per-bill page exists, so a tag built from the
 * target collapsed exactly the case it was meant to separate.
 *
 * A payload with no usable key groups by type, which is right where the type
 * really does describe one subject: one "email delivery is failing", not four.
 * The key is bounded and read as text like every other field here, so a hostile
 * payload can neither mint unbounded buckets nor put anything but a short string
 * in the tag.
 */
function collapseTag(payload) {
  var type = pushText(payload.type, 'monize');
  var key = pushText(payload.collapseKey, '');
  return key === '' ? type : type + '|' + key;
}

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    var parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function pushText(value, fallback) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300
    ? value
    : fallback;
}

// The actions the worker knows how to handle. Anything else in the payload is
// dropped: an action id is what `notificationclick` branches on, so an unknown
// one would be a button that does nothing.
var KNOWN_PUSH_ACTIONS = ['stop-reminder'];

function pushActions(value) {
  if (!Array.isArray(value)) return [];
  var actions = [];
  for (var i = 0; i < value.length && actions.length < 2; i += 1) {
    var item = value[i];
    if (!item || typeof item !== 'object') continue;
    if (KNOWN_PUSH_ACTIONS.indexOf(item.action) === -1) continue;
    var title = pushText(item.title, '');
    if (title === '') continue;
    actions.push({ action: item.action, title: title });
  }
  return actions;
}

// Only our opaque same-origin chart route may trigger an image download.
function safeNotificationImage(value) {
  return typeof value === 'string' && /^\/api\/v1\/push\/chart\/[a-f0-9]{64}\.[0-9]{13}\.[a-f0-9]{64}\.png$/.test(value)
    ? value : undefined;
}

function pushReminderId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : undefined;
}

self.addEventListener('push', function (event) {
  var payload = readPushPayload(event);
  var target = safeNotificationPath(payload.target);

  event.waitUntil(
    self.registration.showNotification(
      pushText(payload.title, PUSH_FALLBACK_TITLE),
      {
        body: pushText(payload.body, PUSH_FALLBACK_BODY),
        image: safeNotificationImage(payload.image),
        icon: PUSH_ICON,
        badge: PUSH_BADGE,
        // Collapse repeats of ONE subject onto one notification rather than
        // stacking four of them, and let two different subjects stack. See
        // `collapseTag`: the subject is the payload's `collapseKey`, and a
        // payload without one is saying its type IS the subject.
        tag: collapseTag(payload),
        // The reminder id rides along so the Stop action below can name what
        // to stop; `actions` is the server's list, filtered to the ids this
        // worker handles.
        data: { target: target, reminderId: pushReminderId(payload.reminderId) },
        actions: pushActions(payload.actions),
        // A test push exists to be looked at: keep it until dismissed rather
        // than letting a desktop banner auto-hide it in seconds. Real alerts
        // keep the platform's default so they do not pile up.
        requireInteraction: payload.type === 'TEST',
      }
    )
  );
});

// A browser may rotate a push subscription on its own -- a key refresh, a long
// idle period, storage pressure. The old endpoint stops working and the stored
// row keeps naming it: delivery just stops, and nothing retires the row until
// something tries to send to it.
//
// The worker resubscribes with the key the old subscription carried (the server
// checks it is still current, and refuses if a rotation is what caused this),
// but it cannot register the result itself: the API is CSRF-protected by a
// double-submit cookie the worker has no portable way to read. So it tells the
// page, which has the session and the token. With no page open, the settings
// panel already reads this browser's endpoint on load and offers to enable
// again -- the message is the fast path, not the only one.
function applicationServerKeyOf(subscription) {
  return (
    subscription && subscription.options && subscription.options.applicationServerKey
  );
}

/** Tell every open window, so the settings panel reconciles even if we cannot. */
function announceSubscriptionChange() {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        clientList[i].postMessage({ type: 'monize-push-subscription-changed' });
      }
    });
}

self.addEventListener('pushsubscriptionchange', function (event) {
  // Firefox -- where Web Push is most used -- fires this with NO oldSubscription,
  // and so did Chrome before the event's properties shipped. Returning early
  // there meant the browsers that need this handler most got nothing from it:
  // no resubscribe, and no message, so even a window with the settings panel
  // open learned nothing and delivery stayed dead until somebody happened to
  // open Settings again.
  var key =
    applicationServerKeyOf(event.oldSubscription) ||
    applicationServerKeyOf(event.newSubscription);

  // No key to subscribe with is not a reason to stay silent: the page holds the
  // session and the CSRF token this worker cannot read, so it can do the whole
  // thing itself. Announcing is the part that must always happen.
  if (!key) {
    event.waitUntil(announceSubscriptionChange().catch(function () {}));
    return;
  }

  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then(announceSubscriptionChange)
      .catch(function () {
        // The resubscribe failed -- a rotation, a revoked permission. The panel
        // is still the durable path, so it is told either way.
        return announceSubscriptionChange().catch(function () {});
      })
  );
});

// Cookie Store avoids a round trip where available. Other workers obtain the
// token from the authenticated, non-cacheable same-origin JSON endpoint.
function readCsrfTokenFromStore() {
  if (self.cookieStore && typeof self.cookieStore.get === 'function') {
    return self.cookieStore
      .get('csrf_token')
      .then(function (cookie) {
        return cookie ? cookie.value : null;
      })
      .catch(function () {
        return null;
      });
  }
  return Promise.resolve(null);
}

// The Stop endpoint retains JWT authentication, ownership checks and the CSRF
// double-submit guard. Failure still opens the reminders page.
function postStop(reminderId, headers) {
  return fetch(
    '/api/v1/notifications/reminders/' +
      encodeURIComponent(reminderId) +
      '/stop',
    { method: 'POST', credentials: 'include', headers: headers }
  );
}

function refreshSession() {
  return fetch('/api/v1/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  })
    .then(function (response) {
      return !!response && response.ok;
    })
    .catch(function () {
      return false;
    });
}

function postStopWithCsrf(reminderId) {
  return readCsrfTokenFromStore().then(function (token) {
    if (token) return postStop(reminderId, { 'X-CSRF-Token': token });
    return fetch('/api/v1/auth/csrf-refresh', {
      method: 'GET',
      credentials: 'include',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    }).then(function (response) {
      // Propagate a 401 to the bounded session-refresh path below. Never send
      // a state-changing request when token retrieval failed.
      if (!response.ok) return response;
      return response.json().then(function (data) {
        if (!data || typeof data.csrfToken !== 'string' ||
            data.csrfToken.length === 0 || data.csrfToken.length > 512) {
          return { ok: false, status: 403 };
        }
        return postStop(reminderId, { 'X-CSRF-Token': data.csrfToken });
      });
    });
  });
}

function stopReminderFromAction(reminderId) {
  return postStopWithCsrf(reminderId)
    .then(function (response) {
      if (response && response.status === 401) {
        return refreshSession().then(function (refreshed) {
          // Refresh rotates CSRF cookies too: acquire the new token instead
          // of retrying with the header from the expired session.
          return refreshed ? postStopWithCsrf(reminderId) : response;
        });
      }
      return response;
    })
    .then(function (response) {
      return !!response && response.ok;
    })
    .catch(function () {
      return false;
    });
}

// Focusing is a courtesy the browser may refuse: WindowClient.focus() needs
// transient activation, and without it Chromium rejects with InvalidAccessError
// (headless has none at all). By then the navigation below has already put the
// user's window on the page they asked for, which is the outcome -- so a refused
// focus resolves quietly rather than rejecting the waitUntil the click handler
// is holding.
function focusQuietly(client) {
  try {
    return Promise.resolve(client.focus()).catch(function () {});
  } catch (error) {
    return Promise.resolve();
  }
}

// Focus an open same-origin window and navigate it, or open one. Shared by the
// ordinary body click and the Stop-action fallback.
function focusOrOpen(url) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (typeof client.navigate === 'function') {
          // The catch belongs to the NAVIGATE: a client that cannot be
          // navigated is still worth focusing. Written around the focus as
          // well, it answered a refused focus by calling the identical focus
          // again -- a retry that changes nothing, so it failed twice and the
          // second rejection escaped.
          return client
            .navigate(url)
            .catch(function () {
              return client;
            })
            .then(function (navigated) {
              return focusQuietly(navigated || client);
            });
        }
        return focusQuietly(client);
      }
      return self.clients.openWindow(url);
    });
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var data = event.notification.data || {};
  // Re-validated rather than trusted: the stored data IS the payload, so it is
  // no more trustworthy here than it was on arrival.
  var url = new URL(safeNotificationPath(data.target), self.location.origin)
    .href;

  // A Stop action on a reminder push: the dispatch puts `actions` and
  // `reminderId` on a re-emitted nag's payload, and the push handler above
  // carries the id in `data`. Silence the reminder
  // without opening a window -- unless the stop did not take, in which case open
  // the active reminders page so the user can finish stopping it
  // there rather than being left with a nag that keeps firing.
  if (event.action === 'stop-reminder') {
    var reminderId = data.reminderId;
    if (typeof reminderId === 'string' && reminderId) {
      event.waitUntil(
        stopReminderFromAction(reminderId).then(function (stopped) {
          if (!stopped) return focusOrOpen(self.location.origin + '/reminders');
        })
      );
    }
    return;
  }

  event.waitUntil(focusOrOpen(url));
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadOfflineStrings() {
  return caches.open(CACHE_NAME)
    .then(function (cache) { return cache.match(OFFLINE_STRINGS_URL); })
    .then(function (response) { return response ? response.json() : null; })
    .then(function (stored) {
      return Object.assign({}, OFFLINE_DEFAULT_STRINGS, stored || {});
    })
    .catch(function () {
      return OFFLINE_DEFAULT_STRINGS;
    });
}

function buildOfflineHtml(strings) {
  var darkRules =
    'background:' + OFFLINE_COLORS.dark.background + ';' +
    'color:' + OFFLINE_COLORS.dark.foreground + ';';
  // The computed colours of the user's active palette win outright; failing
  // those, an explicit resolved theme picks the stock palette; with neither
  // stored the palette follows the system preference.
  var themeCss;
  if (isSafeCssColor(strings.background) && isSafeCssColor(strings.foreground)) {
    themeCss =
      'body{background:' + strings.background + ';color:' + strings.foreground + ';}';
  } else if (strings.theme === 'dark') {
    themeCss = 'body{' + darkRules + '}';
  } else if (strings.theme === 'light') {
    themeCss = '';
  } else {
    themeCss = '@media (prefers-color-scheme: dark){body{' + darkRules + '}}';
  }

  return '<!doctype html>' +
    '<html lang="' + escapeHtml(strings.lang) + '" dir="' + escapeHtml(strings.dir) + '">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>' + escapeHtml(strings.title) + '</title>' +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:12px;' +
    'padding:calc(env(safe-area-inset-top) + 16px) 24px calc(env(safe-area-inset-bottom) + 16px);' +
    'text-align:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;' +
    'background:' + OFFLINE_COLORS.light.background + ';' +
    'color:' + OFFLINE_COLORS.light.foreground + ';}' +
    themeCss +
    'img{width:72px;height:72px;margin-bottom:8px;}' +
    'h1{font-size:20px;margin:0;}' +
    'p{font-size:14px;line-height:1.5;margin:0;max-width:28rem;}' +
    'a{color:inherit;font-weight:600;font-size:14px;text-decoration:underline;}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<img src="/icons/monize-logo-transparent.svg" alt="">' +
    '<h1>' + escapeHtml(strings.title) + '</h1>' +
    '<p>' + escapeHtml(strings.message) + '</p>' +
    '<a href="/">' + escapeHtml(strings.retry) + '</a>' +
    '</body></html>';
}

function buildOfflineResponse() {
  return loadOfflineStrings()
    .then(function (strings) {
      return new Response(buildOfflineHtml(strings), {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    })
    .catch(function () {
      return new Response(buildOfflineHtml(OFFLINE_DEFAULT_STRINGS), {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    });
}

// Race the navigation against a timer rather than aborting it: a navigation
// Request's mode cannot be reconstructed for an AbortController-wrapped
// fetch, and a late success is simply ignored. The returned promise always
// resolves -- a rejection here would surface as a browser error page, which
// in the installed PWA looks like the stuck splash this exists to prevent.
function handleNavigation(request) {
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (responsePromise) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(responsePromise).then(resolve, function () {
        resolve(buildOfflineResponse());
      });
    };
    var timer = setTimeout(function () {
      finish(buildOfflineResponse());
    }, NAVIGATION_TIMEOUT_MS);

    fetch(request).then(
      function (response) { finish(response); },
      function () { finish(buildOfflineResponse()); }
    );
  });
}

// Fetch: Network-with-fallback for navigations, Cache-First for static
// assets, Network-Only for everything else
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigation(event.request));
    return;
  }

  if (!isStaticAsset(event.request.url)) return;

  event.respondWith(
    caches.match(event.request).then(function (cachedResponse) {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then(function (networkResponse) {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }

        var responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});
