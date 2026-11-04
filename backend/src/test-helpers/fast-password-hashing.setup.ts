// Jest `setupFiles` entry for the unit suite. The services hash passwords with
// bcrypt at cost 10 or 12, and the auth, users and two-factor specs drive that
// path hundreds of times, so real hashing was most of their run time (cost 12
// is about 250ms per hash). Here the work is done at bcrypt's minimum cost
// while the callers still pass their own: a spy on `bcrypt.hash` sees the cost
// the service chose, a hash still verifies with `compare`, and a hash a spec
// stored at a higher cost still compares, because the cost lives in the hash.
//
// `module.exports` of bcryptjs is a plain object (its `require` entry is a UMD
// bundle), the same one every `import * as bcrypt` reads through, so replacing
// its functions here reaches every caller in the file under test.
const TEST_COST = 4;

type Bcrypt = typeof import("bcryptjs");
const bcrypt = jest.requireActual<Bcrypt>("bcryptjs");

const cheaper = (saltOrRounds: unknown) =>
  typeof saltOrRounds === "number"
    ? Math.min(saltOrRounds, TEST_COST)
    : saltOrRounds;

const { hash, hashSync, genSalt, genSaltSync } = bcrypt;

Object.assign(bcrypt, {
  hash: (password: string, salt: number | string, ...rest: unknown[]) =>
    (hash as (...args: unknown[]) => unknown)(password, cheaper(salt), ...rest),
  hashSync: (password: string, salt?: number | string) =>
    hashSync(password, cheaper(salt) as number | string | undefined),
  genSalt: (rounds?: unknown, ...rest: unknown[]) =>
    (genSalt as (...args: unknown[]) => unknown)(
      cheaper(rounds ?? TEST_COST),
      ...rest,
    ),
  genSaltSync: (rounds?: number) =>
    genSaltSync(cheaper(rounds ?? TEST_COST) as number),
});
