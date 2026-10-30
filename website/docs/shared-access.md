# Shared Access (Delegated Users)

Shared Access lets you grant another person scoped access to your Monize accounts -- ideal for spouses, family members, accountants, or bookkeepers who need to view (and optionally update) parts of your financial data without sharing your password.

There are two ways an account can be shared, and they are chosen per account, per person:

| Way to share | How it feels to the other person | Best for |
|--------------|----------------------------------|----------|
| **Delegation** (the original behaviour) | They switch context and look at *your* ledger, then switch back | Accountants, bookkeepers, someone helping you occasionally |
| **Joint account** (added in v1.14.0) | Your account simply appears in *their* own account list, register and net worth -- no context switching | A couple sharing a chequing account |

Both are configured from the same **Edit access** dialog, and both are governed by the same per-account read / create / edit / delete grants. Joint is an extra toggle on top of a read grant, not a separate feature.

Each delegate has their own login. Shared Access is not available in demo mode.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Owner** | The user who owns the accounts and grants access |
| **Delegate** | A separate user who has been granted access to one or more of the owner's accounts |
| **Grantee** | A delegate viewed from the perspective of a specific joint account -- the person the account is shared *with* |
| **Delegate-only user** | A user account that was created by an owner via Shared Access and has never registered or claimed their own data |
| **Full account** | A delegate who is a Monize user in their own right: they own accounts, share their own data with someone, or are an administrator. Only full accounts can be given joint access. |
| **Acting as** | The session state when a delegate is currently viewing an owner's data |
| **Joint account** | An account the owner has flagged as joint for a particular delegate, making it appear natively in that delegate's own data |

Delegates always have their own credentials. The owner's password is never shared, and the delegate sees only the data the owner has explicitly granted -- nothing else.

---

## The Shared Access Page

Open **Settings** (the gear icon with your name in the top-right corner) and choose **Shared Access** in the settings menu, or click the **Shared Access** card on the Settings page.

The page lists everyone you have shared with. Each row shows the person's email and a summary of what they can reach: their **Status**, how many **Sections** and **Accounts** are granted, how many **Shared data** permissions they hold, and how many of the accounts are **joint**. Each row has three buttons: **Edit access**, **Reset password** and **Remove**.

![The Shared Access page, listing two delegates with a summary of what each can reach](images/shared-access-list.png)

---

## Adding a Delegate

1. Open **Settings > Shared Access**
2. Click **Add delegate**
3. Enter the delegate's **Email**

![The Add delegate dialog for a new email address, with the name fields, the email invite switch and the password field](images/shared-access-add.png)

Monize checks the address against existing Monize logins a moment after you stop typing ("Checking this email against existing Monize accounts..."). From there, one of three paths applies:

| Scenario | What you do | Result |
|----------|-------------|--------|
| **Email already has a Monize login** | Click **Add delegate** | The existing user gains access using their current login. No password or invite step, and their credentials are never touched. |
| **New email, you set the password** | Optionally enter a **First name** and **Last name**, then a **Password** | A new user is created with that password. Share it with the delegate out-of-band; they can change it after signing in. |
| **New email, send an email invite** | Optionally enter the names, then turn on **Send an email invite instead of setting a password** | A new user is created with no password. An invite email is sent containing a one-time link valid for 24 hours; the delegate sets their own password. |

![The Add delegate dialog for an address that already has a Monize login: the person keeps their own credentials](images/shared-access-add-existing.png)

> [!NOTE]
> The password must meet Monize's standard requirements: at least 12 characters, with an uppercase letter, a lowercase letter, a number and a special character. Passwords are also checked against the [Have I Been Pwned](https://haveibeenpwned.com/) breach database. The email invite needs outbound email; on a server without it, set a password instead.

If the address check itself fails (for example, the server could not be reached), the dialog says so and pauses adding the delegate until a **Check again** succeeds. That way an existing person's password can never be overwritten by mistake.

> [!IMPORTANT]
> **Joint access and account type.** A delegate you create here with a password or invite is an *owner-managed* identity. Joint sharing is offered only for delegates who are full Monize accounts of their own, so if you intend to share an account jointly with your spouse, have them register (or add them by their existing email) rather than creating a credential for them.

After the delegate is added, they appear in the list with zero accounts granted. The next step is to configure permissions.

### Turning a Delegate Login Into a Full Account

A delegate you created with a password can later make the login their own: they open the registration page, enter the same email, and register with the password you gave them (or with a new password, entering yours to prove they hold the login). From then on the login is theirs -- you can no longer reset its password, and once they have data of their own you can share accounts with them jointly. A login protected by two-factor authentication cannot be claimed this way; that person simply signs in.

---

## Configuring Delegate Permissions

From the delegate's row in the Shared Access list, click **Edit access** to open the permissions dialog. It has three tabs: **Accounts**, **Sections** and **Shared data**. Nothing changes until you click **Save**; closing the dialog with unsaved changes asks before discarding them.

### Accounts Tab

Choose which accounts the delegate can see, and what they can do with each.

![The Accounts tab of the Edit access dialog, with Vacation Fund shared jointly and Mastercard read-only](images/shared-access-edit.png)

Each account row has five toggles:

| Toggle | Meaning |
|--------|---------|
| **Read** | See the account, its balance, and its transactions |
| **Create** | Add new transactions to the account |
| **Edit** | Modify existing transactions in the account |
| **Delete** | Delete transactions from the account |
| **Joint** | The account appears natively in the delegate's own account list, register and net worth -- no context switching. See [Joint Accounts](#joint-accounts). |

**Read is required for Create, Edit, Delete, and Joint.** On an account row those four toggles stay greyed out until Read is on, and turning Read off clears them. If you grant no Read access at all, the delegate sees nothing for that account.

Accounts are grouped by type (Chequing, Savings, Credit Card, etc.), and each group has a **Grant all** row whose toggles switch a column on or off for every account in the group -- turning on Create, Edit, Delete or Joint there turns on Read as well. This lets you scope access broadly, for example sharing all chequing accounts with your spouse while keeping investment accounts private.

**Joint is disabled for delegates who are not full Monize accounts.** Hovering the toggle explains why: *"Joint accounts can only be shared with users who have their own Monize account"*.

> [!NOTE]
> **You can only share what you own.** Accounts that somebody else shared with you do not appear in this tab at all, so a joint account can never be re-shared onward -- only its owner can share it.

### Sections Tab

Section toggles give the delegate **read-only** access to whole feature areas of the application:

![The Sections tab of the Edit access dialog, with Bills & Deposits, Budgets and Reports granted](images/shared-access-edit-sections.png)

| Section | What it controls |
|---------|------------------|
| **Bills & Deposits** | Scheduled transactions for the accounts they can read |
| **Investments** | Holdings and investment transactions for the accounts they can read |
| **Budgets** | Budget figures, read-only |
| **Reports** | Built-in and custom reports, read-only |
| **AI Assistant** | Natural-language questions answered with your configured AI provider |
| **Warranties** | Your warranties, their documents and their claims, the Warranties link in Tools and the dashboard widget. A warranty's linked purchase appears only when its account is one the delegate can read. See [Warranties](warranties.md#sharing-with-a-delegate). |

Sections apply to the delegate **while acting as you**. They have no bearing on joint accounts, which live in the delegate's own context.

A section is only useful if the delegate also has Read access to the accounts that feed it. For example, granting **Reports** without granting Read on any account produces empty reports.

> [!NOTE]
> **AI Assistant.** The assistant reads across every account and section, so it only answers for a delegate who can read **all** of your accounts and has every other section turned on. With anything less, the section is granted but the assistant does not answer. When it does answer, the delegate uses *your* configured AI provider and counts against *your* AI usage.

### Shared Data Tab

Categories, payees, and tags are shared reference data across all of your accounts. This tab controls whether the delegate can change them:

![The Shared data tab of the Edit access dialog, with Create allowed for payees and tags](images/shared-access-edit-shared-data.png)

| Resource | Toggles |
|----------|---------|
| **Payees** | Create, Edit, Delete |
| **Categories** | Create, Edit, Delete |
| **Tags** | Create, Edit, Delete |

Read access to all three is always allowed -- delegates need to see payees, categories, and tags to make sense of any transaction. A delegate sees **Payees**, **Categories** or **Tags** in the **Tools** menu only when they hold at least one of these permissions for it.

> [!TIP]
> A common setup is to enable **Create** for all three but leave **Edit** and **Delete** off. This lets the delegate enter transactions naturally (creating new payees as needed) without being able to rename or remove existing entries that affect your historical data.

The **Payees > Create** and **Categories > Create** permissions also govern whether a grantee may create a new payee or category while entering a transaction on a joint account.

---

## Joint Accounts

*Added in v1.14.0.*

Plain delegation means *acting as* the other person: you switch context, see their ledger, and switch back. That is right for a bookkeeper and wrong for a couple sharing a chequing account.

Turning on **Joint** for an account (on top of **Read**) makes that account appear in the other person's own data as though it were theirs. Nothing to remember, nothing to switch.

### What the Grantee Gets

Once an account is joint, the grantee sees it in their own context:

- **Account list** -- listed alongside their own accounts, with a **Joint** badge and *"Shared by [your name]"*. A **Shared with me** filter switch on the accounts page narrows the list to shared accounts only.
- **Register** -- the account's transactions, and (where permitted) the ability to add, edit and delete rows in it
- **Net worth** -- included by default; see [Net Worth](#net-worth)
- **Account detail page** -- the balance chart, cash flow, top categories, top payees and balance forecast, computed exactly as the owner sees them

![Jordan's own Accounts page: their chequing account, with two of Demo User's accounts listed beside it as Joint, Shared by Demo User](images/shared-access-joint-grantee.png)

What the grantee can *do* is still your existing per-account grants: **Read**, **Create**, **Edit**, **Delete**. Those grants are enforced by the server, not merely by hiding buttons.

The grantee never gets ownership of the account object. Renaming, closing, reconciling, changing settings on and deleting a joint account are the owner's alone -- those actions are not offered on a joint row and are rejected server-side.

### Which Account Types Can Be Written To

Only everyday banking accounts accept grantee writes. The rest are shared read-only no matter which grant flags are turned on:

| Account type | Shareable as joint | Grantee writes |
|--------------|--------------------|----------------|
| Chequing, Savings, Cash, Credit Card, Line of Credit | Yes | Create / Edit / Delete, as granted |
| Investment, Loan, Mortgage, Asset, Other | Yes | **None** -- read-only regardless of the grant flags |

The effective permission the grantee's screen shows is the grant flags combined with this policy, so the interface and the server can never disagree.

### Categories, Payees, and Tags on Joint Accounts

Every transaction in a joint account belongs to the **owner's** ledger, even the rows the grantee writes:

- The grantee picks categories and payees from **your** lists, not theirs. Their own reference data can never land on your rows.
- Typing a brand-new payee name creates it on your ledger, but only if the delegation has **Payees > Create**. Otherwise the transaction is refused with a message asking them to pick one of your existing payees.
- A new category can be created the same way, on your ledger, when the delegation has **Categories > Create**.
- **Tags are personal on both sides.** The grantee cannot set tags on a joint row; your existing tags on those rows display read-only to them, and tag-based breakdowns stay owner-only.

Rows the grantee creates keep their creator attribution, but they are your transactions, on your account, in your reports.

### Net Worth

The grantee decides whether a joint account counts toward **their** net worth, with **Exclude from my net worth** / **Include in my net worth** in the account row's menu. That preference is theirs alone: it is invisible to you, and it is never confused with your own "exclude from net worth" setting.

| Case | In the grantee's net worth? |
|------|-----------------------------|
| Joint account, no exclusion set by the grantee | Yes (the default) |
| Joint account the grantee excluded | No |
| Joint account you excluded from *your* net worth | Yes -- your flag governs your view only |
| Plain (non-joint) granted account | No -- never aggregated into the delegate's own numbers |

Your own net worth is unchanged in every case.

### What the Owner Sees

On your side, a shared account is labelled with how many people it is shared with:

- The **account list** row shows a **Joint** badge and *"Shared with N people"*
- The **edit account** form shows *"Joint account shared with N people"* with a **Manage sharing** link straight to Shared Access

![The owner's account list: Vacation Fund carries a Joint badge and Shared with 1 person, Emergency Fund is not shared](images/shared-access-joint-owner.png)

### What Joint Accounts Do Not Include Yet

These are deliberate scope cuts, not bugs:

- **Reports** (built-in and custom) exclude joint rows
- **AI Assistant and the MCP server** exclude joint rows -- both AI surfaces change together, and neither reads them yet
- **Investment breakdowns** exclude joint investment accounts (the plain net-worth total still includes them)
- Attachments, scheduled transactions and investment holdings on a joint account are not natively visible to the grantee
- Grantees cannot add splits, tags or attachments to joint rows (a split row in a shared account can only be managed by the owner)
- Grantee CSV / QIF export of joint rows is not available yet

Anything in this list is still reachable the old way, if you also grant plain delegated access: the grantee switches into your context and sees it there.

---

## Transfers Between Two People's Accounts

You can transfer money **between an account you own and an account shared with you**, in either direction and from either side. In the transfer form, the account picker lists **Your accounts** and, under **Shared with you**, the other person's accounts you are allowed to move money into, each labelled with its owner.

- Authorization is the ordinary write grant (**Create** / **Edit** / **Delete**) on the shared side.
- Each leg belongs to its own account's owner, so both ledgers stay self-contained -- balances, net worth, reports and exports keep aggregating only your own rows.
- Moving a transfer leg between owners is rejected; so are cross-owner split transfers and cross-owner scheduled transfers.
- The AI Assistant and MCP server cannot create or edit cross-owner transfers; they report a clear error rather than half-doing it.

---

## Unsharing and Re-sharing

Everything about joint access is computed from the grants that exist **right now**. Nothing is copied, so nothing needs repairing.

Turn off **Joint** (or **Read**, or remove the delegate entirely) and on the grantee's next page load:

- The account disappears from their list, register, detail pages and net worth -- no leftovers, no tombstones
- Existing transfers between their account and yours are **frozen, not severed**. Each side keeps its own leg, the counterpart shows as **Hidden account** instead of leaking the other person's account details, and neither side can change the amount, date or account through it. Descriptive fields on your own leg stay editable, and the form says why the rest is locked.
- Deleting your own leg of a frozen transfer removes only your leg and detaches the counterpart, which survives as a one-sided transfer.
- Rows the grantee created in the account stay in your ledger, untouched -- they were always your rows.

Turn **Joint** back on later and all of the above reverses on its own: the account reappears, the masking lifts, and frozen transfers reconnect with no repair step. Note that re-granting plain **Read** does *not* silently restore the joint flag -- you turn it on again deliberately.

The **Hidden account** masking applies everywhere a transfer can be read: lists, transaction detail, exports, and what the AI Assistant and MCP server can see.

---

## What the Delegate Sees

When the delegate is acting as you, their navigation is filtered to what they can reach:

- **Transactions** appears when they can read at least one of your non-investment accounts; **Accounts** when they can read at least one account
- **Bills & Deposits**, **Investments**, **Budgets** and **Reports** appear only if the corresponding section is on, and the **AI** menu only with the AI Assistant section (the AI review inbox is never shown to a delegate)
- In **Tools**, **Payees**, **Categories** and **Tags** appear only with a matching Shared data permission, and **Warranties** only with the Warranties section
- Transactions involving an account the delegate cannot read display the inaccessible side as **Hidden account** in transfers
- The delegate can mark accounts as favourites independently of your own favourites -- their dashboard ordering does not affect yours

If a delegate has no Monize data of their own and only one person shares with them, they go straight into that person's data after signing in.

---

## Switching Context (Viewing Banner)

A delegate who has more than one place to be -- their own data and yours, or the data of several owners -- sees an amber banner under the navigation bar on every page, with a **Switch account** dropdown that names the data they are looking at.

![Jordan viewing Demo User's data: the amber banner with Demo User selected, and a navigation bar holding only the shared sections](images/shared-access-viewing-banner.png)

The dropdown lets the delegate switch between:

- **Their own account** (if they have one, labelled "(you)")
- **Each owner** who has shared access with them

Selecting a different context reloads the page so all data refreshes under the new identity. A delegate with no data of their own and a single owner has nothing to switch between, so the banner is not shown.

> [!NOTE]
> **Purely joint delegations are not listed.** If everything you shared with someone is joint -- every readable account already appears natively, with no sections and no shared-data permissions -- there is nothing extra to see by switching, so you are not offered as a context. A delegation with nothing readable *yet* stays listed, so the delegate can still get in once you grant something, and the context somebody is currently acting as is never pulled out from under them.

> [!TIP]
> The banner is intentionally visible at all times. It guards against the delegate forgetting which dataset they are looking at and entering information into the wrong account.

---

## Resetting a Delegate's Password

If a delegate forgets their password, the owner can issue a new temporary password from the Shared Access list -- but only when the delegate is a **delegate-only user**.

1. Open **Settings > Shared Access**
2. Click **Reset password** on the delegate's row
3. Copy the temporary password (the dialog's **Copy** button) and share it with the delegate out-of-band. It is not shown again.
4. The delegate signs in with the temporary password and is asked to choose a new one

A reset also signs the delegate out everywhere, removes their trusted devices and personal access tokens, and clears any lockout from failed sign-in attempts.

The **Reset password** button is greyed out (hover it for the reason) for delegates who:

- Have registered their own Monize account (they own their credentials -- you cannot overwrite them)
- Own financial accounts of their own
- Are also delegates for a different owner
- Have the admin role
- Sign in through single sign-on

In any of these cases, the delegate must use the standard **Forgot Password** flow on the login page.

> [!NOTE]
> Because joint sharing requires a full Monize account, a delegate you share jointly with always manages their own password.

---

## Removing a Delegate

1. Open **Settings > Shared Access**
2. Click **Remove** on the delegate's row
3. Confirm with **Remove** in the dialog

Removing a delegate immediately revokes all of their access:

- All per-account grants are deleted, including joint flags
- Every joint account disappears from their own account list, register and net worth
- Cross-owner transfers between you freeze as described in [Unsharing and Re-sharing](#unsharing-and-re-sharing)
- Their per-account net-worth exclusions for your accounts are discarded along with the grants
- The delegate's favourite-account list (for your accounts) is removed
- If the delegate is currently signed in and viewing your data, their next request fails with "Delegated access is no longer valid" and they are signed out

If the delegate is a **delegate-only user** who has never created their own accounts and has no other delegations, their login is also deleted. Otherwise the user remains (they keep their own login and any other delegations) -- only the relationship to *your* accounts is removed.

> [!NOTE]
> Removing a delegate does not delete any transactions they created. Records keep their original creator attribution, and rows they entered in a joint account stay on your ledger.

---

## Two-Factor Authentication and Delegation

If you (the owner) have 2FA enabled, **the delegate must also enable 2FA on their own account** before they can act as you.

When a delegate tries to switch into an owner's context and the owner has 2FA but the delegate does not, the switch is blocked with:

> *"That account requires two-factor authentication. Set up 2FA in Settings before switching."*

This is a non-negotiable requirement. Authenticator secrets are per-user and are never shared between the owner and the delegate -- so the delegate must independently prove possession of a second factor for their own login before they can access a 2FA-protected dataset.

See [Settings and Security > Two-Factor Authentication](settings-and-security.md#two-factor-authentication-2fa) for setup details.

---

## Security Notes

- Delegates never see your password, your 2FA secret, your backup codes, or your trusted-device list.
- Changing your password does **not** automatically revoke active delegate sessions -- if you need to cut off a delegate, use **Remove** on the Shared Access page.
- Delegate requests are scoped by the server. Even if a delegate crafted a direct API call to an account they were not granted, the request would be rejected with a permission error.
- Joint access is enforced the same way. Which accounts are natively visible, which of them accept writes, whether a transfer connects and what the net worth includes are all recomputed from the live grants on every request -- the interface never gets to decide.
- An account shared with someone cannot be re-shared by them. Delegated accounts are absent from the Edit access dialog entirely, so sharing never chains.
- A request for a joint account you were not granted returns "not found" rather than "forbidden", so probing cannot confirm that an account exists.
- Invite links are stored only as a fingerprint, expire after 24 hours, and work once.
- Shared Access and emergency access are not part of a [backup](backup-and-restore.md#what-is-backed-up): restoring your data does not restore who you shared it with.
- Personal Access Tokens (see [Settings and Security > Personal Access Tokens](settings-and-security.md#personal-access-tokens-pats)) belong to the user that created them. A delegate's PAT does not grant access to the owner's data -- a delegate would need to switch context interactively and create the PAT while acting as the owner.
