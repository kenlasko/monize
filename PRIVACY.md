# Privacy

Monize keeps your data in your own database, on your own server or PC. It
has no telemetry, no analytics and no crash reporting, and it sends nothing
to the Monize project. The project sees only the download counts GitHub
shows for its releases.

Some features contact other services, listed below. Nothing on this page is
contacted by your browser: the web app talks only to its own Monize server,
and the server makes the requests.

## Contacted Without Any Setup

| Service | Why, and when | What it receives |
| --- | --- | --- |
| [Frankfurter](https://frankfurter.dev) (European Central Bank rates), then Yahoo Finance for a rate Frankfurter does not have | Exchange rates for the currencies in use: at startup when the stored rates are old, and on weekdays after the markets close | Currency codes and dates |
| GitHub (`api.github.com`) | A server checks for a new Monize version at startup and every 12 hours. `UPDATE_CHECK_ENABLED=false` turns it off. | The request alone: your IP address and the user agent `Monize-UpdateCheck` |
| GitHub releases (`github.com`) | Monize for Windows checks for an update once after it starts and when you choose **Check for updates**. It downloads a newer version, and installs it only when you click **Restart now**. | The request alone: your IP address and the app's user agent |
| [Have I Been Pwned](https://haveibeenpwned.com/Passwords) (`api.pwnedpasswords.com`) | When a password is set or changed, to warn about a password that appears in known breaches | The first five characters of the password's SHA-1 hash. Never the password, and never the whole hash. |

`FX_PROVIDERS` changes or limits the exchange rate sources.

## Contacted When You Use a Feature

| Service | When | What it receives |
| --- | --- | --- |
| Price providers: Yahoo Finance by default, MSN Money as its fallback; the London Stock Exchange, Deutsche Boerse or a web page you name, when you choose one for a security | You hold securities or cryptocurrency, on weekdays after the markets close and when you refresh prices; Yahoo also serves the pictures in a security's news | Ticker symbols and dates |
| Bond data: NBP, Statistics Poland, obligacjeskarbowe.pl, TreasuryDirect, the US Bureau of Labor Statistics | You hold bonds whose rates Monize looks up | Nothing about you or your holdings: the requests fetch public tables |
| Google's favicon service (`t2.gstatic.com`) | You enter a website for a payee or a financial institution, to show its logo | That website's address |
| Google Places | The administrator sets a Google Places key, or you add your own, and you look up a payee's contact details | The payee's name |
| Your bank, through SimpleFIN or Enable Banking | You link a bank account | What that service needs to sync it, including your access to it |
| The AI provider you add (Anthropic, OpenAI, Ollama or another compatible service), or the one the administrator sets | You use the AI assistant or its insights | Your questions and the financial data needed to answer them |
| Your mailbox (IMAP, Google or Microsoft) | You connect a mailbox to Email Receipts | Your mailbox credentials or sign-in, to read receipts from it |
| The email server the administrator sets | Password resets, invitations and notifications by email | The email and its recipient |
| The single sign-on provider the administrator sets | You sign in with it | The sign-in exchange |
| The push service of a browser or device you subscribe | Push notifications | Each notification's content |
| S3-compatible storage you set up | Off-site backup copies | Your backups |

Monize for Windows has no email, no single sign-on and no administrator
settings, so the rows about those do not apply to it.
