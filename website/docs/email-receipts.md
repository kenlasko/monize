# Email Receipts

Monize can read **order confirmations from a mailbox** and turn them into itemized transactions: it finds the bank transaction the email belongs to, fills in the line items, and shows you what it proposes before anything changes.

This page covers **connecting the mailbox** -- a Gmail account above all, since Google's rules decide how you should connect, then Microsoft 365 and any other IMAP server -- and what to do when the connection fails. How emails are read, matched and approved (profiles, the Emails tab, AI assistance) is documented separately.

---

## How It Works

- **Where it lives.** The **Email Receipts** hub is under **Tools** in the main menu (and as a card on the Settings page). It has four tabs: **Overview**, **Emails**, **Profiles** and **Mailbox**. The mailbox connection itself is at **Settings > Email Receipts**.
- **What it reads.** Order confirmations are read from a dedicated mailbox over IMAP. Monize **only reads** it: it never changes, moves or deletes a message, and it opens the folder read-only.
- **How often.** With *Read the mailbox automatically* on, the folder is read every 15 minutes. **Poll now** reads it on demand at any time.
- **Use a dedicated mailbox.** Every message in the folder is read, so it should hold nothing but order confirmations. With Gmail the natural "dedicated mailbox" is a **label**: create a filter that applies a label such as `Receipts` to the shops' confirmations, and point Monize at that label. Gmail labels appear to IMAP as folders (a nested label is written `Parent/Child`).
- **Who can use it.** The account owner only. A delegate sees neither the settings nor the receipts pages.
- **What it needs on the server.** `ENCRYPTION_KEY` must be set: a mailbox password or sign-in is stored encrypted, and cannot be saved without it.

<!-- Screenshot: Settings > Email Receipts with the "Connect with Google" button above the manual IMAP form -->

---

## Gmail: Choosing How to Connect

There are two ways to connect a Gmail mailbox, and Google's policies -- not Monize -- decide which one fits you. IMAP has no narrower Google scope than `https://mail.google.com/`, which Google classes as **restricted**: an app that asks for it must either be verified by Google (an annual, paid security assessment) or live with the limits Google puts on unverified apps.

| Path | What you need | Limits | Best for |
|------|---------------|--------|----------|
| **A. App password** through the manual IMAP form | A personal Google account with **2-Step Verification** on | Not available for Google Workspace ("work, school or organization") accounts, accounts in Advanced Protection, or accounts whose 2-Step Verification uses security keys only | **Personal Gmail. Start here.** No Google Cloud project, nothing to verify, no expiry. |
| **B. Connect with Google**, audience *External*, status *Testing* | A Google Cloud project with an OAuth client (set up by the administrator) | Only the **test users** listed on the project (up to 100) can connect, and every grant **expires after 7 days** -- the mailbox then stops and asks to be reconnected | Trying the feature out, or a tiny group that accepts a weekly Reconnect |
| **C. Connect with Google**, audience *Internal* | A **Google Workspace** organisation, with the Cloud project inside it | Only accounts in that Workspace domain can connect | A family or business on Google Workspace. No verification, no 7-day expiry. |
| **D. Connect with Google**, *External*, *In production* | Google's restricted-scope verification (about 6 weeks) **plus** a CASA Tier 2 security assessment by a Google-authorised lab, repeated every year, costing hundreds to thousands of dollars | None after verification | Not realistic for a self-hosted deployment. Monize does not offer this. |

Both Google paths give Monize the same access: a scope that *could* write to the mailbox. Monize still opens the folder read-only and exposes no write operation, so the mailbox is never changed.

---

## Gmail with an App Password

An app password is a 16-character passcode that lets one app sign in to your Google account without your real password. It is the simplest way to connect a personal Gmail account.

### 1. Create the app password in Google

1. Turn on **2-Step Verification** for the Google account if it is not already on (Google Account > Security). App passwords exist only on accounts with 2-Step Verification.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), give the password a name such as `Monize receipts` and click **Create**.
3. Copy the 16 characters shown. Google shows them once; spaces are ignored.

> **Advanced Protection:** app passwords are not available on an account enrolled in Google's [Advanced Protection Program](https://landing.google.com/advancedprotection/), and enrolling later revokes any app password already created, so a mailbox saved with one stops working. Use a separate Gmail account for receipts instead.

If the page says app passwords are not available, the account is a Workspace account, is in Advanced Protection, or uses security keys only. Those accounts connect with Google instead (see below) or, for Workspace, ask the administrator for the Internal path.

### 2. Enter the mailbox in Monize

1. Go to **Settings > Email Receipts**.
2. In the manual form, fill in:

| Field | Value |
|-------|-------|
| **IMAP server** | `imap.gmail.com` |
| **Port** | `993` |
| **Connection security** | **TLS (usually port 993)** |
| **User name** | the full Gmail address |
| **Password** | the 16-character app password |
| **Folder** | `INBOX`, or the label you dedicated to receipts (a nested label is `Parent/Child`) |

3. Click **Test connection**. Monize logs in and reports *"The connection works. The folder holds N messages."* or the error the server returned.
4. Click **Save mailbox**.

Once saved, the password is never shown again. Editing the mailbox with the password left blank keeps the stored one.

---

## Connect with Google (OAuth)

With this path the user never types a password into Monize: they sign in at Google, approve the access, and Monize stores a refresh token (encrypted with `ENCRYPTION_KEY`) that it trades for a short-lived access token every time it reads the mailbox. The IMAP host is always Google's own `imap.gmail.com:993`; the user does not choose a host or port.

The **Connect with Google** button appears only after the administrator has registered an OAuth client and set both of its environment variables. One client serves every user of the deployment.

### For the administrator

Decide the **audience** first, using the table above: **Internal** if your deployment belongs to a Google Workspace organisation and everyone who will connect is in it; otherwise **External**, which stays in **Testing** with its 7-day expiry.

1. Sign in to the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick one). No billing account is needed, and no API has to be enabled: IMAP sign-in uses only the OAuth scope.
2. Open **Google Auth Platform** (the former "OAuth consent screen"; search for it in the console).
   - **Branding**: give the app a name such as `Monize` and a support email. Add your deployment's domain under *Authorized domains* if the console asks for one.
   - **Audience**: choose **Internal** or **External**. For External, add every Google account that will connect under **Test users** (up to 100). Leave the publishing status on **Testing**.
   - **Data Access**: click **Add or remove scopes** and add `https://mail.google.com/` (it is listed under *Gmail API* or can be pasted manually), plus `openid` and `.../auth/userinfo.email`. Save.
3. Open **Clients** > **Create client**. Application type **Web application**, any name, and under **Authorized redirect URIs** add exactly:

```
https://your-monize-host/settings/email-receipts/oauth-callback
```

   That is `PUBLIC_APP_URL` (no trailing slash) followed by `/settings/email-receipts/oauth-callback`. It must match character for character.

4. Copy the **Client ID** and **Client secret** into the backend environment:

```bash
PUBLIC_APP_URL=https://your-monize-host
ENCRYPTION_KEY=...                     # already required for other secrets
EMAIL_RECEIPTS_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET=GOCSPX-...
```

5. Restart the backend. **Settings > Email Receipts** now shows **Connect with Google** above the manual form. A provider with only one of the two variables set is not offered at all.

What Monize sends and stores: the authorization request asks for `https://mail.google.com/ openid email` with `access_type=offline` and `prompt=consent`, so Google returns a refresh token on every connection. The login name is the email address from the ID token. The refresh token is the only credential kept, encrypted; the access token lives in memory for one poll.

### For the user

1. Go to **Settings > Email Receipts** and click **Connect with Google**.
2. Choose the Google account. On an External client in Testing, Google warns *"Google hasn't verified this app"*: click **Continue** (this is expected; the administrator's project is unverified by design). An account that is not on the test-user list is refused here.
3. Approve the access Google lists. The browser returns to Monize's *Connecting the mailbox* page, then to the settings with **Connected to Google as you@gmail.com.**
4. Set the **Folder** to read (`INBOX` or your receipts label), turn on **Read the mailbox automatically**, choose the **AI mode**, and click **Save settings**. See [Mailbox Settings](#mailbox-settings).
5. Click **Poll now** to read the folder straight away and follow *View the saved emails*.

<!-- Screenshot: The OAuth panel showing "Connected to Google as ..." with Reconnect and Disconnect buttons and the mailbox settings below -->

### Reconnect, Disconnect and revoking

- **Reconnect** runs the Google sign-in again and replaces the stored token. Use it when the panel says *"The connection to Google is not active, so the mailbox is not being read. Connect again to resume."* -- on an External/Testing client that happens every 7 days.
- **Disconnect** deletes Monize's stored token and stops reading the mailbox. Emails already stored are kept.
- Disconnecting does **not** withdraw the permission you granted. To do that, remove Monize on [Google account permissions](https://myaccount.google.com/permissions); the panel links there. Revoking at Google without disconnecting in Monize is fine too: the next poll records *"The mailbox's sign-in was revoked or has expired"* and stops until you reconnect.

---

## Microsoft 365

Microsoft 365 works the same way as Google: the administrator registers one app, and users click **Connect with Microsoft**.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations > New registration**. Platform **Web**, redirect URI `${PUBLIC_APP_URL}/settings/email-receipts/oauth-callback`.
2. Under **Certificates & secrets**, create a client secret and copy its value.
3. Under **API permissions**, add the **delegated** permission `IMAP.AccessAsUser.All` (Office 365 Exchange Online) plus the OpenID permissions `openid`, `email` and `offline_access`. An organisation may still need to enable IMAP for the mailbox and allow users to consent to the app.
4. Set the environment:

```bash
EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID=...
EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET=...
EMAIL_RECEIPTS_MICROSOFT_TENANT=common   # optional, default shown
```

`EMAIL_RECEIPTS_MICROSOFT_TENANT` decides who may sign in: `common` (work, school and personal accounts), `organizations`, `consumers`, or one tenant's GUID or domain. A value that is not a valid tenant disables Microsoft sign-in and logs a warning. The IMAP host is fixed to `outlook.office365.com:993`.

---

## Any Other IMAP Server

The manual form takes any IMAP server: host, port, **TLS** (usually 993) or **STARTTLS** (usually 143), user name and password. Most providers require an **app password** rather than the account password. The server's certificate is always verified; there is no "accept any certificate" switch.

Two server-side rules apply to the host:

- **Private addresses.** A host that is a private, loopback or link-local address (`localhost`, `192.168.x.x`, a container name, `.local`, `.internal`) can be used only by an **administrator**, unless the operator lists it in `EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST` (for example `mail.lan:993,192.168.1.30:993`). The check runs when the mailbox is saved and again on every connection.
- **How much one poll reads.** `EMAIL_RECEIPTS_MAX_MESSAGES_PER_POLL` (default 50) caps the messages read per poll; the rest wait for the next one. `EMAIL_RECEIPTS_MAX_MESSAGE_BYTES` (default 2,000,000) is the largest message downloaded; a larger one is recorded as skipped and never fetched.

---

## Mailbox Settings

These settings are the same for a password mailbox and a connected one.

| Setting | What it does |
|---------|--------------|
| **Folder** | The folder to read. It is opened read-only. Changing it starts reading the new folder from the beginning. |
| **Read the mailbox automatically** | When on, Monize reads the mailbox every 15 minutes. Turning it off does not disconnect the mailbox, and **Poll now** reads it whether this is on or off. |
| **AI mode** | **Off**: the poll never calls the AI for receipts. **On demand**: the poll never calls the AI, but you can ask the assistant yourself from an email. **Automatic**: the poll asks the AI about a matched receipt that no approved profile could read completely, and drafts a profile for a sender that has none. Every AI answer is a proposal you approve. |
| **Apply proposals automatically** | Off by default. A proposal is applied without asking only when an approved profile read the whole email, the transaction was found by an order number or reference, or by exact amount and payee with a single candidate, and the proposal adds up to the cent. Everything else waits for your approval. |
| **Count profile proposals toward the daily AI limit** | On by default. Turn it off when a large batch of stored emails would otherwise use up the daily limit of AI-proposed changes. |

The status block shows the **Last poll**, the **Last successful poll** and the **Last error**, and offers **Poll now** and **Delete mailbox**. Deleting the mailbox removes the settings and every stored email from Monize; the emails in the mailbox itself are not touched.

---

## Troubleshooting

| Message | What it means |
|---------|---------------|
| No **Connect with Google** button, only the manual form | The server has not set both `EMAIL_RECEIPTS_GOOGLE_CLIENT_ID` and `EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET`, or was not restarted after setting them. |
| *"Sign-in with this provider is not set up on this server."* | Same cause, reached by an old page or a stale link. Ask the administrator. |
| Google: **Error 400: redirect_uri_mismatch** | The redirect URI registered on the client does not equal `PUBLIC_APP_URL` + `/settings/email-receipts/oauth-callback`. Check the scheme (`https`), the host, the port, and that `PUBLIC_APP_URL` has no trailing slash. |
| Google: **Error 403: access_denied** or *"has not completed the Google verification process"* | The client is External in Testing and this account is not on its **Test users** list; or the client is Internal and the account is outside the Workspace domain. |
| *"Google hasn't verified this app"* | Expected for an unverified (Testing) client. Click **Continue**. |
| *"The provider did not grant lasting access. Remove this app's access in your account's security settings and connect again."* | Google returned no refresh token. Remove Monize on [Google account permissions](https://myaccount.google.com/permissions) and click **Connect with Google** again. |
| *"The mailbox's sign-in was revoked or has expired. Connect the mailbox again in the mailbox settings."* | On an External/Testing client this is the 7-day expiry; otherwise the grant was revoked or the account password changed. Click **Reconnect**. To stop it recurring, move to the Internal audience or to an app password. |
| *"This sign-in link is not valid any more. Start connecting the mailbox again."* | The sign-in took too long or the callback was opened twice. Start again from the settings. |
| *"The provider did not accept the sign-in, so the mailbox was not connected."* | The code exchange failed, most often a wrong client secret or a secret that has expired. The administrator should check the client's credentials. |
| *"This server has no encryption key configured, so a mailbox sign-in cannot be stored."* | The deployment has no `ENCRYPTION_KEY`. Nothing can be saved until the administrator sets one. |
| *"The stored sign-in cannot be read on this server. Connect the mailbox again in the mailbox settings."* | The token was stored under a different `ENCRYPTION_KEY`, typically after a restore onto another instance. Reconnect. |
| Test connection: *"Application-specific password required"* or *"Invalid credentials"* | The account password was used instead of an app password, or the account cannot have one (Workspace, Advanced Protection, security keys only). Create an app password, or use **Connect with Google**. |
| *"This mail server address is a private or local network address..."* | A non-administrator entered a private host. Only an administrator can use one, unless the operator allows it in `EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST`. |
| Connected, but the folder reads 0 messages | The **Folder** does not match: Gmail labels are case-sensitive, and a nested label is `Parent/Child`. **Test connection** on the manual form reports the count; on a connected mailbox use **Poll now**. |

---

## Related

- [Settings and Security](settings-and-security.md) -- the Settings page and the Email Receipts card
- [Getting Started](getting-started.md) -- the `.env.example` sections, including *Email receipts*
- [AI](ai.md) -- the AI providers the **AI mode** setting can use
