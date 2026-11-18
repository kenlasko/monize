import { escapeHtml } from "../common/escape-html.util";
import { tr } from "../i18n/translate";
import { displayClientName } from "./client-identity";
import {
  type ConsentRequester,
  describeRedirectTarget,
  describeRequester,
  hostOf,
} from "./redirect-target";

interface ConsentParams {
  uid: string;
  clientName: string;
  clientUri: string | null;
  /**
   * The redirect_uri of THIS authorization request, from the interaction's
   * params (which the provider has already matched against the client's
   * registered list). Never the client's metadata: that is self-asserted.
   */
  redirectUri: string | null;
  userEmail: string;
  scopes: string[];
  resource: string;
}

const SCOPE_LABELS: Record<string, { title: string; description: string }> = {
  "monize:read": {
    title: "Read your financial data",
    description:
      "View accounts, transactions, budgets, categories, payees, holdings, and reports.",
  },
  "monize:write": {
    title: "Modify your financial data",
    description:
      "Create and update transactions, categories, payees, and other records.",
  },
};

export function renderConsentPage(params: ConsentParams): string {
  const {
    uid,
    clientName,
    clientUri,
    redirectUri,
    userEmail,
    scopes,
    resource,
  } = params;

  // Scopes are shown as a read-only list, not toggles: the OAuth client fixes
  // the requested scope set, and node-oidc-provider re-prompts indefinitely if
  // any requested scope is withheld. The user's choice is Allow (grant all) or
  // Deny.
  const scopeRows = scopes
    .map((scope) => {
      const meta = SCOPE_LABELS[scope] ?? {
        title: scope,
        description: "",
      };
      return `
        <li class="scope">
          <div>
            <strong>${escapeHtml(meta.title)}</strong>
            <p>${escapeHtml(meta.description)}</p>
          </div>
        </li>`;
    })
    .join("\n");

  // Clients register themselves (open Dynamic Client Registration), so the
  // name and client_uri are whatever the registrant typed. The one fact this
  // page can vouch for is where the authorization code will be delivered: the
  // redirect_uri of this request. Show its origin prominently, and never let
  // the self-asserted client_uri pose as that destination: it is plain text,
  // and it is flagged when its host differs from the redirect host.
  // The heading therefore names the destination, and the self-chosen name is
  // demoted to a line that says it is only what the application calls itself.
  const shownName = displayClientName(clientName, "unknown");
  const heading = escapeHtml(requesterHeading(describeRequester(redirectUri)));
  const selfNamed = escapeHtml(
    tr(
      "common.oauthConsent.selfNamed",
      `It calls itself "${shownName}". Monize has not checked that name.`,
      { name: shownName },
    ),
  );
  const pageTitle = escapeHtml(
    tr("common.oauthConsent.pageTitle", "Allow access to your Monize account?"),
  );
  const destination = describeRedirectTarget(redirectUri);
  const destinationBlock = destination
    ? `<div class="destination">
      <p>${escapeHtml(tr("common.oauthConsent.destinationLabel", "If you allow access, Monize will send the authorization to:"))}</p>
      <p class="origin">${escapeHtml(destination)}</p>
    </div>`
    : `<div class="destination warning">
      <p>${escapeHtml(tr("common.oauthConsent.destinationUnknown", "Monize could not determine where this authorization would be sent. Do not allow access."))}</p>
    </div>`;

  const clientUriHost = hostOf(clientUri);
  let clientUriBlock = "";
  if (clientUri && clientUriHost && clientUriHost === hostOf(redirectUri)) {
    clientUriBlock = `<p class="claimed">${escapeHtml(
      tr(
        "common.oauthConsent.claimedWebsite",
        `Website stated by the application: ${clientUri}`,
        { website: clientUri },
      ),
    )}</p>`;
  } else if (clientUri) {
    clientUriBlock = `<p class="notice mismatch">${escapeHtml(
      tr(
        "common.oauthConsent.websiteMismatch",
        `The application says its website is ${clientUri}, but the authorization will be sent to a different address.`,
        { website: clientUri },
      ),
    )}</p>`;
  }

  const unverifiedNotice = escapeHtml(
    tr(
      "common.oauthConsent.unverifiedNotice",
      "This application registered itself with this Monize server, and Monize has not verified who operates it; its name is whatever it chose to call itself. Only allow access if you started this connection yourself from that application and the address above belongs to it.",
    ),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${pageTitle}</title>
<style>
  :root {
    --primary: #0284c7;
    --primary-hover: #0369a1;
    --bg: #f8fafc;
    --card: #ffffff;
    --text: #0f172a;
    --muted: #64748b;
    --border: #e2e8f0;
    --meta-bg: #f1f5f9;
    --secondary-bg: #ffffff;
    --secondary-hover: #f1f5f9;
    --warn-bg: #fffbeb;
    --warn-border: #f59e0b;
    --warn-text: #78350f;
  }
  /* Track the OS-level theme. The wider Monize app supports an explicit
     three-way (light / dark / system) preference, but the consent page
     is a one-screen flyway that loads with no client-side state — there
     is nowhere to retrieve the user's selection from, and the page never
     re-renders. Following prefers-color-scheme is the right tradeoff. */
  @media (prefers-color-scheme: dark) {
    :root {
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --bg: #0f172a;
      --card: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --border: #374151;
      --meta-bg: #111827;
      --secondary-bg: #1f2937;
      --secondary-hover: #374151;
      --warn-bg: #422006;
      --warn-border: #d97706;
      --warn-text: #fde68a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    width: 100%;
    max-width: 520px;
    padding: 32px;
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p.subtitle { margin: 0 0 24px; color: var(--muted); font-size: 14px; }
  ul.scopes { list-style: none; padding: 0; margin: 0 0 24px; }
  li.scope {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 8px;
  }
  li.scope strong { display: block; font-size: 14px; }
  li.scope p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .meta {
    background: var(--meta-bg);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 24px;
    word-break: break-all;
  }
  .actions { display: flex; gap: 12px; }
  button {
    flex: 1;
    border: none;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  button.primary { background: var(--primary); color: #fff; }
  button.primary:hover { background: var(--primary-hover); }
  button.secondary { background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--secondary-hover); }
  .destination {
    border: 2px solid var(--primary);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .destination p { margin: 0; }
  .destination .origin {
    margin-top: 6px;
    font-size: 16px;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  .warning, .notice {
    border: 1px solid var(--warn-border);
    background: var(--warn-bg);
    color: var(--warn-text);
  }
  .notice {
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    margin: 0 0 12px;
    word-break: break-word;
  }
  .claimed { font-size: 12px; color: var(--muted); margin: 0 0 12px; word-break: break-all; }
  .user { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .brand { font-size: 14px; font-weight: 600; color: var(--primary); margin-bottom: 16px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">Monize</div>
    <h1>${heading}</h1>
    <p class="subtitle">${selfNamed}</p>
    ${destinationBlock}
    <p class="notice">${unverifiedNotice}</p>
    ${clientUriBlock}
    <p class="user">Signed in as <strong>${escapeHtml(userEmail)}</strong></p>

    <form method="POST" action="/api/v1/oauth-consent/${escapeHtml(uid)}/confirm" autocomplete="off">
      <ul class="scopes">${scopeRows}</ul>
      <div class="meta">Resource: ${escapeHtml(resource)}</div>
      <div class="actions">
        <button type="submit" formaction="/api/v1/oauth-consent/${escapeHtml(uid)}/abort" class="secondary">Deny</button>
        <button type="submit" class="primary">Allow access</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

/** The consent page's heading: who is asking, by the address the code goes to. */
function requesterHeading(requester: ConsentRequester | null): string {
  switch (requester?.kind) {
    case "web":
      return tr(
        "common.oauthConsent.headingWeb",
        `${requester.host} wants access to your Monize account`,
        { host: requester.host },
      );
    case "device":
      return tr(
        "common.oauthConsent.headingDevice",
        "An application on this device wants access to your Monize account",
      );
    case "app":
      return tr(
        "common.oauthConsent.headingApp",
        `An app that opens ${requester.scheme} links wants access to your Monize account`,
        { scheme: requester.scheme },
      );
    default:
      return tr(
        "common.oauthConsent.headingUnknown",
        "An unidentified application wants access to your Monize account",
      );
  }
}
