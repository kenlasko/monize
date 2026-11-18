/**
 * The text of local-network access: the tray items, the dialogs and the
 * "Set up another device" window. Part of `TEXT` (`strings.ts`, as
 * `TEXT.lan`); kept in its own file only for size.
 */

export const LAN_TEXT = {
  trayAccess: "Allow other devices on my network",
  traySetup: "Set up another device...",

  enableTitle: "Allow other devices on your network?",
  enableMessage:
    "Phones, tablets and other computers on your home network will be able " +
    "to open Monize and sign in with your Monize account. Nothing outside " +
    "your home network can connect, and every connection is encrypted.",
  enableDetail:
    "Windows may ask whether to allow Monize through its firewall: allow it " +
    "on private networks. On a standard Windows account, that needs an " +
    "administrator's password.\n\n" +
    "Each device trusts Monize once, by installing Monize's certificate; the " +
    "next window shows how. A device can reach Monize only while this PC is " +
    "on and Monize is running.",
  enableAllow: "Allow",
  cancel: "Cancel",

  failedTitle: "Monize could not open itself to your network",
  failedDetail:
    "Monize keeps working on this PC as before. The logs say what happened; " +
    "you can try again from the tray icon.",

  setupTitle: "Set up another device",
  setupIntro:
    "Do this once on each phone, tablet or computer you want to use Monize on. " +
    "The device must be on the same network as this PC.",
  stepCertificate: "1. Install Monize's certificate on the device",
  stepCertificateBody:
    "Scan this code with the device's camera and download the file, or save " +
    "the certificate and send it to the device yourself. It lets the device " +
    "check that it is talking to this PC; it cannot be used for any website " +
    "on the internet.",
  saveCertificate: "Save certificate...",
  fingerprint: "Fingerprint (SHA-256), to compare with what the device shows:",
  platformsHeading: "Installing it",
  platforms: [
    {
      name: "iPhone and iPad",
      steps:
        "Open the downloaded file from Settings (Profile Downloaded) and " +
        "install it. Then turn it on under Settings > General > About > " +
        "Certificate Trust Settings.",
    },
    {
      name: "Android",
      steps:
        "Open Settings and search for “CA certificate” (usually under " +
        "Security > Encryption & credentials > Install a certificate), then " +
        "choose the downloaded monize-root.crt. Chrome then trusts it. " +
        "Firefox needs one more setting: in Firefox, open Settings > About " +
        "Firefox and tap the Firefox logo five times, then go back to " +
        "Settings > Secret Settings, turn on “Use third party CA " +
        "certificates”, and close and reopen Firefox.",
    },
    {
      name: "Windows",
      steps:
        "Open the file and choose Install Certificate, Current User, then " +
        "Trusted Root Certification Authorities. Firefox keeps its own list: " +
        "import the file in its settings under Certificates.",
    },
    {
      name: "Mac",
      steps:
        "Open the file to add it to Keychain Access, then open it there and " +
        "set Trust to Always Trust.",
    },
  ],
  stepOpen: "2. Open Monize on the device",
  stepOpenBody:
    "Scan this code, or type the first address into the device's browser. " +
    "Sign in as usual; from the browser's menu you can then install Monize " +
    "as an app.",
  otherAddresses: "If that address does not open, try one of these:",
  warningHeading: "If the browser warns that the connection is not secure",
  warningBody:
    "Do not choose “Accept the risk”, “Proceed” or “Continue to the site”. " +
    "The warning means the device does not trust Monize's certificate yet: " +
    "go back to step 1 and finish installing it. A browser you let past the " +
    "warning remembers that, and keeps calling Monize not secure even after " +
    "the certificate is installed.",
  warningRecovery:
    "Already let it past? Clear all of that browser's data, then open the " +
    "address again. On Android: Settings > Apps > the browser > Storage > " +
    "Clear storage. The browser's own “Clear browsing data” is not always " +
    "enough. Clearing storage also removes the browser's bookmarks, open " +
    "tabs and saved passwords on that device, unless they are synced.",
  noMdnsName: (reason: string) =>
    `The name monize.local could not be set up on this network (${reason}), so use an address below.`,
  replaceHeading: "If this PC was compromised",
  replaceBody:
    "Replacing the certificate makes every device you have set up stop " +
    "trusting Monize until you install the new one on it.",
  replaceButton: "Replace certificate...",

  replaceTitle: "Replace Monize's certificate?",
  replaceMessage:
    "Every device you have set up stops trusting Monize until you install " +
    "the new certificate on it. Do this only if this PC was compromised, or " +
    "if you no longer trust a device that has the old one.",
  replaceConfirm: "Replace",

  saveTitle: "Save Monize's certificate",
  saveFileName: "monize-root.crt",
  saveFilter: "Certificate",
  notRunning:
    "Other devices cannot reach Monize right now. Turn on “Allow other " +
    "devices on my network” in the tray menu.",
} as const;
