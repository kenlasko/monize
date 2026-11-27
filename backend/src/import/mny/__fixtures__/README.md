# Microsoft Money test fixtures

Real `.mny` files used by the MSISAM decryption, reader and import specs. Mapper
and writer unit specs use plain-object fixtures; a purpose-built file may also
exercise the complete parser and database writer path when its serialized Money
shape is the behavior under test.

## Provenance

The five `money20*.mny` files are copied verbatim from the
[jackcess-encrypt](https://github.com/jahlborn/jackcessencrypt) project,
`src/test/data/`, which distributes them under the **Apache License 2.0**.
They are small, purpose-built sample files created by that project for its own
codec tests; they contain no real personal financial data.

| File | Money era | Encryption | Password |
|---|---|---|---|
| `money2001.mny` | Money 2001 | old (Jet-style RC4, key derived from the header) | none |
| `money2001-pwd.mny` | Money 2001 | old (Jet-style RC4, key derived from the header) | none -- opens without one, same as jackcess |
| `money2002.mny` | Money 2002 | new (MD5 digest, `0x298` flag bit `0x20` clear) | none |
| `money2008.mny` | Money Plus / Sunset | new (SHA-1 digest, `0x298` flag bit `0x20` set) | none |
| `money2008-pwd.mny` | Money Plus / Sunset | new (SHA-1 digest) | `Test12345` |
| `sample-cd-redemption.mny` | Money Plus / Sunset | new (SHA-1 digest) | none |
| `sample-money99.mny` | Money 99 | none (plain Jet 3) | none |
| `sample-money99-investments.mny` | Money 99 | none (plain Jet 3) | none |

`sample-money99.mny` is a Money 99 (Spanish locale) file with fabricated data, built by
the author of the community converter
[catrucho/Money-import](https://github.com/catrucho/Money-import) and contributed
to Monize with their permission. It is the only Jet 3 fixture: banking rows, a
split, transfers, a loan with its payment history, scheduled bills, a voided row,
one row of every investment action Money 99 offers short of interest and short
sales, and employee stock option events. Money 99's own account list for it is
the ground truth `mny-parser.service.spec.ts` asserts (Chase Bank 2,105.00, card
-185.00, investment cash 22,658.00, savings 11,010.00, loan -4,209.39, 11 AMZN),
along with its four monthly bills; its scheduled loan payment has no paying
account and is skipped.
Its EUR->USD rate of 112 is a typo in the source file, kept as found.

`sample-money99-investments.mny` is the same author's later copy of that file,
built to reproduce what their real Money 99 file raised on import: a bond and a
CD bought and paying interest (`act` 2), more other income and expenses, extra
and split loan payments from the bank account, and a second 1:2 AMZN split.
Recording that split rewrote every earlier AMZN trade in place (quantities
doubled, prices halved), which is why the two files' AMZN rows differ. The
balances `mny-parser.service.spec.ts` asserts for it are the sums of Money's own
register rows per account, not yet Money 99's account list.

`sample-cd-redemption.mny` was purpose-built for Monize with synthetic data and
contains no personal financial data. Its "Sample 3-month CD" activity is a
5,000 purchase, three reinvested-interest
transactions of 20 each, and a 5,061 redemption comprising 5,060 of proceeds
plus 1 of accrued interest. It guards Money Plus's observed encoding of that
redemption as `act = 2` (SELL) with positive `TRN_INV.amtInt`.

The passwords are recorded in jackcess-encrypt's
`src/test/java/com/healthmarketscience/jackcess/crypt/CryptCodecProviderTest.java`.

`money2008.mny` is worth calling out: its crypt-check bytes are **not** blank,
yet it verifies against the blank password. A file having check bytes is
therefore not evidence that it is password protected -- see
`msisam-decrypt.ts`.

## Expected contents

`CryptCodecProviderTest` also pins the full table list of each file; the reader
specs assert the same table counts and a few known rows, so a regression in the
decryptor shows up as a table-list mismatch rather than a vague parse error.
`money2001.mny` has no `BILL` table -- that is the Money 2001 layout that
crashed the PR #192 proof of concept, and it is the fixture that guards
`getTableOrNull`.

## Licence

The five `money20*.mny` files are Apache License 2.0, Copyright the
jackcess-encrypt authors. See <https://www.apache.org/licenses/LICENSE-2.0>.
They are retained here under that licence. `sample-cd-redemption.mny` is part of
Monize and is licensed under the repository's AGPL-3.0-only licence, as is
`sample-money99.mny` and `sample-money99-investments.mny`, contributed for that
purpose.
