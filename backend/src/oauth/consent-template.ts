import { escapeHtml } from "../common/escape-html.util";

interface ConsentParams {
  uid: string;
  clientName: string;
  clientUri: string | null;
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
  const { uid, clientName, clientUri, userEmail, scopes, resource } = params;

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

  const clientLink = clientUri
    ? `<a href="${escapeHtml(clientUri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clientName)}</a>`
    : escapeHtml(clientName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Authorize ${escapeHtml(clientName)} — Monize</title>
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
  .user { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .brand { font-size: 14px; font-weight: 600; color: var(--primary); margin-bottom: 16px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">Monize</div>
    <h1>Authorize ${clientLink}</h1>
    <p class="subtitle">${clientLink} is requesting access to your Monize account.</p>
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
