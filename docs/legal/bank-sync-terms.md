# Monize bank sync: terms of use

> **Template, not legal advice.** These terms describe how the bank sync
> feature of a Monize instance may be used. The person or organization that
> runs the instance (the operator) is responsible for checking that they fit
> their situation and the law that applies to them. An operator who serves
> other people should publish their own version, with their name, and have it
> reviewed by a qualified professional.

Last reviewed against the code: 2026-10-01 (`docs/specs/bank-sync.md`).

## 1. The service

Bank sync reads account information from the user's bank through Enable
Banking, a licensed account information service provider (AISP) under PSD2,
and imports booked transactions into the user's Monize accounts. Access is
read-only. Bank sync does not initiate payments.

## 2. Who may use it

- The user connects only bank accounts that they hold, or that they are
  authorized to access.
- The user uses their own Enable Banking application, and accepts Enable
  Banking's own terms for it.

## 3. Consent

- The user gives consent at their own bank. The consent is valid until its
  expiry date, at most 180 days, or until the user revokes it.
- The user can revoke the consent at any time: in Monize (Disconnect), at the
  bank, or in the Enable Banking control panel.

## 4. Accuracy

- Monize imports what the bank reports. The bank's records are the
  authoritative source.
- Monize imports only booked transactions. Pending transactions do not appear
  until the bank books them.
- A bank can limit how often its data is read without the user present
  (under PSD2, usually about four times a day). Monize syncs automatically
  once a day.
- The user checks imported transactions and balances before relying on them
  for a decision.

## 5. Availability

Bank sync depends on the bank, on Enable Banking and on the instance's
network access to `api.enablebanking.com`. It can be unavailable at any time.
Monize is open-source software provided "as is", without warranty, under the
license in the repository's `LICENSE` file.

## 6. Data

The privacy notice in [`bank-sync-privacy.md`](./bank-sync-privacy.md) says
which data is read and stored, where, and for how long.

## 7. Changes

The operator can change these terms. The version in force is the one
published at the address that the operator registered with Enable Banking.
