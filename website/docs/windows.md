# Monize for Windows

Monize for Windows is the whole of Monize in one installer: the web application, its server and its PostgreSQL database run on your own PC, with a Start Menu entry, a tray icon, automatic updates and an uninstaller. Nothing else has to be installed first: no Docker, no WSL, no Node and no separate PostgreSQL.

Out of the box it is a single-PC installation: everything listens on `127.0.0.1` only, so Monize is reachable from this PC and from nowhere else. You can let phones, tablets and other computers on your home network use it too, with one setting in the tray menu: see [Using Monize on Other Devices](#using-monize-on-other-devices). It is never reachable from the internet; for that, run the [Docker or Kubernetes installation](getting-started.md#installation) on a server instead. [What the Windows App Cannot Do](#what-the-windows-app-cannot-do) lists everything that follows from this.

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
| **Allow other devices on my network** | Lets phones, tablets and other computers on your home network open Monize (see [Using Monize on Other Devices](#using-monize-on-other-devices)). Off until you turn it on. |
| **Set up another device...** | Shows how to connect a phone, tablet or computer, with codes to scan. Available while **Allow other devices on my network** is on. |
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

## Using Monize on Other Devices

Monize can serve the phones, tablets and other computers on your home network, so you can use it from the sofa or install it on your phone as an app, with push notifications. It is off until you turn it on, and it never makes Monize reachable from the internet.

### Turning It On

1. Right-click the tray icon and choose **Allow other devices on my network**, then **Allow**.
2. Windows may ask whether to allow Monize through its firewall. Allow it on **private networks**. On a standard Windows account this needs an administrator's password.
3. The **Set up another device** window opens. Keep it open while you set up your first device.

Choosing the item again turns it off: other devices can no longer connect, and Monize keeps working on this PC as before.

### Setting Up a Device

Each device has to trust Monize once, by installing Monize's certificate. The certificate is what lets the device check that it is talking to your PC and keeps the connection encrypted. It is made for your installation and can only vouch for addresses on your home network, never for a website on the internet.

1. On this PC, open **Set up another device...** from the tray menu.
2. On the device, scan the first code with the camera and download the certificate. You can also click **Save certificate...** and send the file to the device yourself, for example by email or AirDrop.
3. Install it:
   - **iPhone and iPad:** open **Settings**, tap **Profile Downloaded** and install it. Then turn it on under **Settings > General > About > Certificate Trust Settings**.
   - **Android:** open **Settings** and search for *CA certificate* (usually under **Security > Encryption & credentials > Install a certificate**), then choose the downloaded `monize-root.crt`. Chrome then trusts it. Firefox needs one more setting: in Firefox, open **Settings > About Firefox** and tap the Firefox logo five times, then go back to **Settings > Secret Settings**, turn on **Use third party CA certificates**, and close and reopen Firefox.
   - **Windows:** open the file and choose **Install Certificate**, **Current User**, then **Trusted Root Certification Authorities**. Firefox keeps its own list: import the file in its settings under **Certificates**.
   - **Mac:** open the file to add it to Keychain Access, then open it there and set **Trust** to **Always Trust**.
4. Scan the second code, or type the address the window shows (`https://monize.local:3382`) into the device's browser, and sign in as usual. From the browser's menu you can then install Monize as an app.

**If the browser warns that the connection is not secure, do not choose *Accept the risk*, *Proceed* or *Continue to the site*.** The warning means the device does not trust Monize's certificate yet: finish installing it first. A browser you let past the warning remembers that, and keeps calling Monize not secure even after the certificate is installed.

If you already let it past, clear all of that browser's data, then open the address again. On Android, that is **Settings > Apps >** the browser **> Storage > Clear storage**: the browser's own *Clear browsing data* is not always enough. Clearing storage also removes the browser's bookmarks, open tabs and saved passwords on that device, unless they are synced.

The window also shows the certificate's fingerprint. If you want to be sure the device downloaded the right file, compare it with the fingerprint the device shows for the certificate.

### Addresses

The window lists every address Monize answers on, best first:

- `https://monize.local:3382`, the name Monize gives itself on your network. If another PC on the network already runs Monize, this one becomes `monize-2.local`, and keeps that name.
- `https://<computer name>.local:3382`, your PC's own name.
- `https://<IP address>:3382`, which works even where `.local` names do not (some older Android phones, and some networks). If the router gives the PC a new IP address, the old one stops working; the names keep working.

The port is 3382 unless another program already uses it.

### Good to Know

- A device can reach Monize only while this PC is on and Monize is running. **Start Monize when I sign in** helps.
- Each person signs in with their own Monize account, as on a server. The Windows account and the data stay on this PC.
- If this PC is ever compromised, or you no longer trust a device that has the certificate, click **Replace certificate...** in the **Set up another device** window. Every device then has to install the new certificate.

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
| Use Monize away from home, or from the internet | Other devices can connect only from your home network, and only after you [turn that on](#using-monize-on-other-devices). The database and the server themselves are never exposed to the network. | Run the [Docker or Kubernetes installation](getting-started.md#installation) on a server, and [restore your data](backup-and-restore.md#restoring-from-a-backup) into it. |
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
| A phone cannot open `https://monize.local:3382` | Try the IP address the **Set up another device** window lists: some phones and networks do not resolve `.local` names. If no address opens, check that the phone is on the same network as the PC (not a guest network), that Windows has the network set to **Private** (Settings > Network & internet), and that Monize is allowed through the firewall on private networks. |
| The phone says the connection is not private or not secure | The phone does not trust Monize's certificate yet: install it as in [Setting Up a Device](#setting-up-a-device). On an iPhone, also turn it on under **Certificate Trust Settings**; in Firefox on Android, also turn on **Use third party CA certificates**. |
| Monize opens on the phone, but the padlock still says not secure | The browser was let past a certificate warning before the certificate was installed, and remembers it. Clear all of that browser's data (on Android: **Settings > Apps >** the browser **> Storage > Clear storage**) and open the address again. |
| Anything else | **View logs** in the tray menu. When you report a problem, include `main.log` and `backend.log` from the logs folder. |
