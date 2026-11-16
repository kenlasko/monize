# Monize for Windows

Monize for Windows is the whole of Monize in one installer: the web application, its server and its PostgreSQL database run on your own PC, with a Start Menu entry, a tray icon, automatic updates and an uninstaller. Nothing else has to be installed first: no Docker, no WSL, no Node and no separate PostgreSQL.

It is a single-PC installation. Everything listens on `127.0.0.1` only, so Monize is reachable from this PC and from nowhere else: not from your phone, not from another computer in the house, and not from the internet. If you want any of those, run the [Docker or Kubernetes installation](getting-started.md#installation) on a server instead. [What the Windows App Cannot Do](#what-the-windows-app-cannot-do) lists everything that follows from this.

---

## Download

| Channel | What it is | Where |
|---------|------------|-------|
| **Release** | The current Monize release. Recommended. | [Latest release](https://github.com/kenlasko/monize/releases/latest): download `Monize-Setup-<version>.exe` under **Assets** |
| **Beta** | A preview built from every change merged since the last release. Less tested. | [Releases page](https://github.com/kenlasko/monize/releases): the release marked **Pre-release**, named **Windows beta** |

There is only ever one beta: each new one replaces the one before it. An installed beta updates itself to the next beta or to the next release, whichever is newer. An installed release never updates to a beta. To leave the beta channel, uninstall (keeping your data) and install the release; [back up](#backups-and-disaster-recovery) first.

**System requirements:** Windows 10 or 11, 64-bit (x64). No administrator rights are needed.

The app and its installer are signed, under the [code signing policy](#code-signing-policy) below.

---

## Installing

1. Run `Monize-Setup-<version>.exe`.
2. The installer is signed with a test certificate until SignPath Foundation issues its own, and Windows does not trust the test certificate, so Windows SmartScreen says *"Windows protected your PC"*. Click **More info**, then **Run anyway**.
3. Choose the installation folder or keep the default, `%LOCALAPPDATA%\Programs\Monize`. Monize installs for your Windows account only and does not ask for administrator rights.
4. The installer copies tens of thousands of files, so the list can sit still for several minutes, longer while antivirus software scans them. Let it finish.
5. Monize starts when the installer closes.

**The first start after installing or updating can take a few minutes.** Monize creates its database, then loads the server for the first time, which antivirus software scans. The splash window says what it is doing and notes when a step is slow. If it reports that a step did not finish in time, click **Retry**.

When it is ready, the window opens on the sign-in page. Click **Sign up**: the first account you create becomes the instance's administrator. Then continue with [First-Time Setup](getting-started.md#first-time-setup).

> [!IMPORTANT]
> The first time the window opens, Monize asks you to **save your recovery key**. Do it: export it to a file or copy it into a password manager, and keep it off this PC. [The Recovery Key](#the-recovery-key) explains why.

---

## The Tray Icon

Closing the window does not stop Monize: it keeps running in the system tray, so reminders and scheduled backups still happen. Right-click the tray icon for:

| Item | What it does |
|------|--------------|
| **Open Monize** | Opens the window. Clicking the icon does the same. |
| **Open in browser** | Opens Monize in your default browser at `http://127.0.0.1:<port>`. Use it to install Monize as a browser app or to get browser push notifications on this PC. |
| **View logs** / **Show logs folder** | Shows the logs of the database, the server and the app, for troubleshooting. |
| **Show recovery key...** / **Export recovery key...** | Shows or saves the recovery key. |
| **Move data folder...** | Moves your data to another folder or drive (see [Moving Your Data](#moving-your-data)). |
| **Start Monize when I sign in** | Starts Monize in the tray when you sign in to Windows. |
| **Check for updates** | Looks for a newer version now. |
| **Quit Monize** | Stops the app, its server and its database. |

The same items, apart from **Open Monize**, are also inside the window, so you do not have to find the tray icon:

- **Help menu:** click **?** in the top bar and choose **Desktop app menu**. The menu opens where you clicked.
- **Menu bar:** press **Alt** to show the window's menu bar, then open **Monize** (or press **Alt+M**). The bar also has Edit, View and Window menus for copy and paste, zoom and reload.

On a PC whose taskbar has no tray area, these two are the only way to reach the items.

---

## Where Your Data Lives

Everything Monize keeps is in one folder for your Windows account, `%LOCALAPPDATA%\Monize` (paste that into File Explorer's address bar to open it):

| Folder or file | Holds |
|----------------|-------|
| `pgdata` | The PostgreSQL database: every account, transaction and setting of every user. |
| `attachments` | Receipts, manuals and other files attached to transactions and warranties. |
| `backups` | Automatic backups (see [Backup and Restore](backup-and-restore.md#automatic-backups)). |
| `logs` | Log files. |
| `config.json` | The ports Monize uses and its passwords and keys, encrypted so that only your Windows account can unlock them. |
| `shell` | The window's own browser profile: your saved sign-in, caches. |

Uninstalling keeps this folder unless you tick **Remove my data** in the uninstaller.

### Moving Your Data

**Move data folder...** in the tray menu moves everything to another folder, for example a second drive with more room. Monize stops, copies the data, checks every file of the copy, switches to it and starts again; you sign in again afterwards. The old folder is kept until you choose to delete it. Use a drive that is always connected: Monize does not start while its data folder is missing.

---

## The Recovery Key

Monize encrypts sensitive values in its database (two-factor sign-in secrets, AI provider keys, mailbox and storage credentials) with a key it creates on first start. On Windows this is the server's `ENCRYPTION_KEY`, which a Docker installation sets in its configuration. Windows keeps the key locked to your account, so it is safe on the PC, but it is lost with the PC.

**Show recovery key...** and **Export recovery key...** in the tray menu give you a copy. Keep it in a password manager or on a USB drive somewhere safe, never on the same PC, and never share it: anyone with the key and a copy of your database can read the encrypted values.

---

## Updates

Monize checks for a new version shortly after it starts, and whenever you choose **Check for updates**. A new version downloads in the background; the tray menu then shows **Restart to update to** followed by the new version number, and a notification says it is ready. Nothing installs until you click **Restart now**: Monize then stops its database cleanly, installs the update and opens again, and the new version updates your database on its first start. **Later** keeps the download for the next restart.

---

## What the Windows App Cannot Do

Monize for Windows runs the same application as a server installation, but on one PC, for one Windows account, with no server settings to change. These differences follow from that:

| You cannot | Why | What to do instead |
|------------|-----|--------------------|
| Use Monize from a phone, a tablet or another computer | Everything listens on `127.0.0.1`, so nothing outside this PC can connect. This is on purpose: the database and the server are never exposed to your network. | Run the [Docker or Kubernetes installation](getting-started.md#installation) on a server, and [restore your data](backup-and-restore.md#restoring-from-a-backup) into it. |
| Install Monize on a phone as an app, or get its push notifications on a phone | A phone cannot reach Monize at all. | Same as above. On this PC, browser push works through **Open in browser**, and the window shows Windows notifications itself. |
| Let other Windows accounts on this PC use the same data | The data folder belongs to one Windows account. Each Windows account that installs Monize gets its own, separate Monize. | Create a Monize account for each person, or share with [Shared Access](shared-access.md); they sign in on this PC, under the Windows account that runs Monize. |
| Send email: password resets by email, email invites, emailed notifications, emailed backup copies | Email needs SMTP server settings, and the Windows app has none to set. | Use in-app and Windows notifications. An administrator sets other users' passwords directly. |
| Use [Emergency Access](emergency-access.md) | Reminders and claim links are sent by email, and a contact would also need to reach Monize. | Write down where your backups and your recovery key are kept and how to restore them, and leave that with someone you trust. |
| Sign in with single sign-on (OIDC) | OIDC is configured with server settings. | Use a password with two-factor authentication. |
| Connect a mailbox to [Email Receipts](email-receipts.md) with **Connect with Google** or **Connect with Microsoft** | Both need an OAuth client the server administrator registers in its settings. | Connect Gmail [with an app password](email-receipts.md#gmail-with-an-app-password), or any [other IMAP server](email-receipts.md#any-other-imap-server). |
| Connect Claude Desktop or another AI client with **Add Connector** (OAuth) | That flow needs Monize on a public HTTPS address. | Use a [personal access token and the local bridge](ai.md#option-2-personal-access-token--local-bridge) from an AI client on this PC, with the address **Open in browser** shows. |
| Sync a bank through Enable Banking with a production application | Enable Banking accepts only an `https` redirect address for production, and the Windows app's address is `http://127.0.0.1`. | Use [SimpleFIN](settings-and-security.md#simplefin) or [file imports](importing-transactions.md). |
| Store backups or attachments in S3 storage chosen by the server, or set server-wide defaults (registration on or off, forced two-factor, a default AI provider, a server-wide Google Places key) | These are server environment settings. | Each user can still add their own S3 bucket for [off-site backup copies](backup-and-restore.md#off-site-copies), their own AI provider and their own Google Places key. |
| Put automatic backups in a folder of your choice | The server only writes backups inside the data folder's `backups` folder. | Copy that folder elsewhere with your own backup tool, add an off-site S3 copy, or use the [full backup script](#full-backup-script). |
| Run a highly available or clustered setup | One PC, one database. | Use the Kubernetes installation. |
| Install on macOS, Linux, Windows on ARM, or 32-bit Windows | Only a 64-bit Windows installer is built. | Run the Docker installation on any of these. |

Everything else works the same as on a server: accounts, transactions, investments, budgets, reports, imports (including [Microsoft Money](importing-from-microsoft-money.md) files), rules, the AI assistant with your own provider, two-factor authentication, attachments, warranties, and backup and restore.

---

## Backups and Disaster Recovery

Your data is on one PC, so a failed disk, a lost or stolen laptop, or a Windows reinstall loses it unless a copy exists somewhere else. Monize gives you three kinds of copy. Use the first two always, and add the third if you want to be able to put the PC back exactly as it was.

| Copy | What it holds | Restores onto | How |
|------|---------------|---------------|-----|
| **In-app backup** (manual or automatic) | One user's data: accounts, transactions, settings and attachments. | Any Monize: this PC, a new PC, a Docker server, any Windows account. | [Backup and Restore](backup-and-restore.md) |
| **Recovery key** | The key that decrypts the encrypted values in the database. | Not a backup by itself. It is what someone technical needs to read the encrypted values in a full backup outside this Windows account (see [Advanced](#advanced-using-the-database-directly)). | Tray menu, **Export recovery key...** |
| **Full backup** | The whole instance: the database with every user, attachments, automatic backups and the encrypted configuration. | **This Windows account only**, on this PC or after replacing its disk. | The [full backup script](#full-backup-script) |

> [!WARNING]
> A full backup does **not** restore on a new PC or under a different Windows account. The passwords Monize uses to open its own database are stored encrypted by Windows for your account (Windows DPAPI), and a different account or a reinstalled Windows cannot unlock them. For a new PC, use in-app backups.

### Recovering on a New PC

1. Install Monize on the new PC and sign up. The first account becomes the administrator.
2. Go to **Settings > Backup & Restore** and restore your most recent in-app backup file (see [Restoring from a Backup](backup-and-restore.md#restoring-from-a-backup)). If it is encrypted, you need the password you set for it.
3. Each other user of the old instance signs up again and restores their own backup.
4. Set up two-factor authentication again: sign-in secrets are not part of a backup.
5. Save the new installation's recovery key.

Keep at least one recent in-app backup somewhere other than this PC. Automatic backups land in the data folder's `backups` folder, which is on the same disk as the database, so also add an [off-site S3 copy](backup-and-restore.md#off-site-copies), or copy that folder to a USB drive or a cloud-synced folder regularly.

### Full Backup Script

`Backup-Monize.ps1` is a PowerShell script that makes a full backup of the data folder and puts one back. It quits Monize, checks that the database shut down cleanly (copying a running PostgreSQL database gives a backup that may not start), copies the whole data folder, checks that every file arrived at the same size, and starts Monize again if it was running.

[Download Backup-Monize.ps1](https://raw.githubusercontent.com/kenlasko/monize/main/desktop/scripts/Backup-Monize.ps1) (right-click, **Save link as**), and save it in a folder of your own, for example `Documents\Monize`.

Run it from a PowerShell window. Windows blocks scripts downloaded from the internet by default, so start it with `-ExecutionPolicy Bypass`:

```powershell
cd $HOME\Documents\Monize

# A full backup into a new, dated folder on drive E:
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Destination E:\MonizeBackups

# The same, as one .zip file
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Destination E:\MonizeBackups -Zip

# Put a full backup back (a backup folder or a .zip)
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Restore E:\MonizeBackups\Monize-backup-20261114-210000.zip
```

- Each backup is a new folder or `.zip` named `Monize-backup-<date>-<time>`, holding a `monize-backup.json` that records when, from which folder, and with which Monize version it was made.
- Monize is closed while the copy runs, usually a minute or two.
- The destination cannot be inside the data folder. Use another drive.
- A restore never deletes your current data: it renames the data folder to `Monize.before-restore-<date>-<time>` first and tells you where it is. Delete that folder once the restored Monize works.
- A restore refuses a backup made under another Windows account or on another PC, because Monize could not unlock it there.
- After a restore, sign in again.
- A backup made by an older version restores and is updated to the installed version's database on the next start. Restoring a backup from a newer version onto an older Monize may not start; update first.
- It finds a moved data folder by itself. `-DataDir` names the data folder and `-MonizeExe` the installed `Monize.exe` when either is somewhere unusual, and `-NoRestart` leaves Monize closed afterwards. `Get-Help .\Backup-Monize.ps1 -Full` lists everything.

To run it on a schedule, create a task in **Task Scheduler** that runs `powershell.exe` with the arguments `-ExecutionPolicy Bypass -File "C:\Users\<you>\Documents\Monize\Backup-Monize.ps1" -Destination E:\MonizeBackups -Zip`, at a time you are usually not using Monize. Delete old backups yourself: the script never deletes one.

### Advanced: Using the Database Directly

The Windows app ships only the parts of PostgreSQL 18 that it runs (`postgres`, `initdb`, `pg_ctl`), not `pg_dump` or `psql`, and its database passwords are kept encrypted for your Windows account. There is no supported way to connect another tool to its database, and Monize has no way yet to open a full backup under another Windows account, even with the recovery key.

- For a portable copy of your data, use an in-app backup.
- To move a whole instance to a server, restore each user's in-app backup on the server.
- The `pgdata` folder of a full backup is an ordinary PostgreSQL 18 data directory. Someone comfortable with PostgreSQL can start it with their own PostgreSQL 18 (for example the official Docker image), after changing `pg_hba.conf` so they can connect without the stored password, and run the Monize server against it with the recovery key as `ENCRYPTION_KEY`. Do this on a copy, never on the only one.

---

## Uninstalling

Use **Settings > Apps > Installed apps > Monize > Uninstall** in Windows. The uninstaller stops Monize first. Your data folder is kept unless you tick **Remove my data**, so reinstalling later picks up where you left off.

---

## Code Signing Policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- **What is signed:** `Monize.exe` and the installer, `Monize-Setup-<version>.exe`. They are built from the [Monize repository](https://github.com/kenlasko/monize) by its GitHub Actions workflow and signed there through SignPath; nothing built anywhere else is signed. Third-party files in the installer, such as Electron's and PostgreSQL's, keep their own publishers' signatures or none.
- **Until SignPath Foundation issues the certificate**, the app and the installer are signed with a test certificate that Windows does not trust.
- **Committers and reviewers:** [kenlasko](https://github.com/kenlasko). Changes from anyone else reach the code only through a pull request that a committer has reviewed.
- **Approvers:** [kenlasko](https://github.com/kenlasko). Every request to sign with the SignPath Foundation certificate waits for an approver.
- **Privacy:** [the privacy statement](https://github.com/kenlasko/monize/blob/main/PRIVACY.md) lists every service Monize contacts, when, and what it sends.

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| SmartScreen blocks the installer | Click **More info**, then **Run anyway**. The installer is signed with a test certificate that Windows does not trust yet; see the [code signing policy](#code-signing-policy). |
| The installer seems stuck | It copies tens of thousands of files and the list does not move while it does. Wait several minutes; antivirus software slows it further. |
| *"This step failed: ... not done within ..."* on the first start | Click **Retry**. The first start after installing can be slow while antivirus software scans the new files. |
| *"Monize has a new address"* | Another program took the port Monize used. Monize moved to a free one and keeps it from now on; update any bookmarks and AI client settings. |
| Monize does not start after the data folder was moved | The drive holding it is not connected. Connect it and start Monize again. |
| Anything else | **View logs** in the tray menu. When you report a problem, include `main.log` and `backend.log` from the logs folder. |
