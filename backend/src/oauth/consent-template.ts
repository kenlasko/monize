import { encode } from "he";

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

function escape(value: string): string {
  // `he.encode` with default options encodes ", ', <, >, & and any non-ASCII
  // chars as numeric character references — equivalent or stricter than the
  // OWASP HTML-context escape set. Used instead of a hand-rolled regex so
  // static analysers don't flag this as manual sanitization (CWE-79).
  return encode(value, { useNamedReferences: true });
}

export function renderConsentPage(params: ConsentParams): string {
  const { uid, clientName, clientUri, userEmail, scopes, resource } = params;

  const scopeRows = scopes
    .map((scope) => {
      const meta = SCOPE_LABELS[scope] ?? {
        title: scope,
        description: "",
      };
      return `
        <li class="scope">
          <label>
            <input type="checkbox" name="scopes" value="${escape(scope)}" checked />
            <div>
              <strong>${escape(meta.title)}</strong>
              <p>${escape(meta.description)}</p>
            </div>
          </label>
        </li>`;
    })
    .join("\n");

  const clientLink = clientUri
    ? `<a href="${escape(clientUri)}" target="_blank" rel="noopener noreferrer">${escape(clientName)}</a>`
    : escape(clientName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Authorize ${escape(clientName)} — Monize</title>
<style>
  :root {
    --primary: #0284c7;
    --primary-hover: #0369a1;
    --bg: #f8fafc;
    --card: #ffffff;
    --text: #0f172a;
    --muted: #64748b;
    --border: #e2e8f0;
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
  li.scope label { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  li.scope input { margin-top: 4px; }
  li.scope strong { display: block; font-size: 14px; }
  li.scope p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .meta {
    background: #f1f5f9;
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
  button.secondary { background: #fff; color: var(--text); border: 1px solid var(--border); }
  button.secondary:hover { background: #f1f5f9; }
  .user { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .brand { font-size: 14px; font-weight: 600; color: var(--primary); margin-bottom: 16px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">Monize</div>
    <h1>Authorize ${clientLink}</h1>
    <p class="subtitle">${clientLink} is requesting access to your Monize account.</p>
    <p class="user">Signed in as <strong>${escape(userEmail)}</strong></p>

    <form method="POST" action="/oauth-consent/${escape(uid)}/confirm" autocomplete="off">
      <ul class="scopes">${scopeRows}</ul>
      <div class="meta">Resource: ${escape(resource)}</div>
      <div class="actions">
        <button type="submit" formaction="/oauth-consent/${escape(uid)}/abort" class="secondary">Deny</button>
        <button type="submit" class="primary">Allow access</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}
