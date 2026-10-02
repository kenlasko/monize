# Monize bank sync: privacy notice

> **Template, not legal advice.** This notice describes what the Monize
> software does with bank data when bank sync is enabled. The person or
> organization that runs a Monize instance (the operator) is responsible for
> the data on that instance and for checking that this notice fits their
> situation and the law that applies to them. An operator who serves other
> people should publish their own version, with their name and contact
> address, and have it reviewed by a qualified professional.

Last reviewed against the code: 2026-10-01 (`docs/specs/bank-sync.md`).

## 1. Who processes the data

- **The operator** runs the Monize instance and stores the data in its
  database. For a personal, self-hosted instance, the operator and the user
  are the same person.
- **Enable Banking** (Enable Banking Oy, Espoo, Finland) is a registered
  account information service provider (AISP) under PSD2, supervised by the
  Finnish Financial Supervisory Authority (FIN-FSA). It connects to the bank
  and passes the account information to Monize. Once the bank is connected,
  Enable Banking can read the bank data: the account data passes through its
  service on the way to Monize. Its consent screen states: "Your payment
  account data flows through Enable Banking API and won't be registered
  there." Its terms apply to what it processes:
  <https://auth.enablebanking.com/terms>.
- **The bank** authenticates the user and provides the account information.

Monize does not send bank data to the Monize project, its authors or any
other third party.

## 2. What Monize reads

Only after the user authorizes access at their own bank, and only for the
accounts the user selects there:

- the list of accounts: name, the account number (IBAN or another
  identifier), currency, account type, and a provider identification hash.
  The account number is used to match a bank account to a Monize account and
  to prefill a new one; lists show only its last four characters;
- booked transactions: date, amount, currency, direction, counterparty name,
  remittance information and the bank's reference;
- the balance the bank reports.

Monize does not read or store bank passwords or other bank sign-in
credentials. The user signs in at the bank, not in Monize. Monize does not
initiate payments.

## 3. What Monize stores, and where

All data stays in the operator's Monize database:

- **The Enable Banking application credentials** (application ID and RSA
  private key). The private key is encrypted with AES-256-GCM under the
  instance's encryption key. It is never returned to the browser and never
  written to a backup.
- **Connections**: the bank name, the consent expiry date, the provider
  session identifier and the last error. The one-time authorization state is
  stored only as a SHA-256 hash.
- **Bank accounts**: the fields in section 2 and the link to a Monize account.
- **Imported transactions**: ordinary Monize transactions in the linked
  account, plus a record of which bank transaction produced each one, which
  prevents duplicates.

For a user-initiated sync, Monize sends the user's IP address and browser
user agent to Enable Banking, so that the bank treats the request as made in
the user's presence. Automatic daily syncs send neither.

## 4. Why

The only purpose is to show the user their own transactions and balances in
Monize, so that they do not have to import bank files by hand.

## 5. How long

- The data stays until the user removes it.
- **Disconnect** removes the connection and its bank account records, and
  asks Enable Banking to end the session.
- **Remove credentials** removes the application ID and the private key.
- Imported transactions are ordinary Monize transactions. They stay until the
  user deletes them or deletes the account.
- The consent at the bank expires by itself on its expiry date, at most 180
  days after authorization.

## 6. The user's controls

In Monize, under Settings, Bank sync, the user can:

- see every connection, its accounts and its consent expiry;
- turn the automatic daily sync off;
- disconnect a bank;
- remove the stored credentials.

At the bank or in the Enable Banking control panel, the user can also revoke
the consent.

## 7. Contact

For a personal instance, the operator is the user. An operator who serves
other people adds their contact address here.
