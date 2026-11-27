# KMyMoney test fixtures

Synthetic KMyMoney files used by the reader and importer specs. No file here
was produced by KMyMoney, and no upstream sample is committed.

## Provenance

`sample-synthetic.xml` is the annotated example of `docs/kmymoney-data-model.md`
section 18, byte for byte. It was written by hand for that reference, following
KMyMoney's reader and writer code, and is free to use as a test fixture.
`sample-synthetic.kmy` is the same bytes gzipped (node `zlib`, default level).

| File | Container | Contents |
|---|---|---|
| `sample-synthetic.xml` | plain XML | 17 accounts (5 standard), 11 transactions, 1 schedule, 1 security, 2 currencies, 3 prices, 1 budget |
| `sample-synthetic.kmy` | gzip | the same document |

`kmy-xml-builders.ts` builds further documents in specs, and `kmy-fixtures.ts`
is the registry (`KMY_FIXTURES`, `readKmyFixture`). The registry is its own;
nothing here belongs in `MNY_FIXTURES`.
