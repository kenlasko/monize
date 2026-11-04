import bcrypt from "bcryptjs";

// Pins `fast-password-hashing.setup.ts`: without these, the setup could stop
// applying (a bcryptjs upgrade that freezes its exports, a reordered
// `setupFiles`) and the only symptom would be a slower suite.
describe("password hashing in the unit suite", () => {
  it("does the work at the minimum cost whatever cost the caller asks for", async () => {
    const hash = await bcrypt.hash("correct horse", 12);

    expect(bcrypt.getRounds(hash)).toBe(4);
    await expect(bcrypt.compare("correct horse", hash)).resolves.toBe(true);
    await expect(bcrypt.compare("wrong horse", hash)).resolves.toBe(false);
  });

  it("still lets a spy see the cost the caller chose", async () => {
    const spy = jest.spyOn(bcrypt, "hash");

    await bcrypt.hash("correct horse", 12);

    expect(spy).toHaveBeenCalledWith("correct horse", 12);
    spy.mockRestore();
  });

  it("still verifies a hash stored at a higher cost", async () => {
    // Made at cost 10 with the unpatched bcryptjs, for "password".
    const stored =
      "$2b$10$AZSj1/dzg.WiZ2o2cs.oPuvhb1XDsDzFbW2lQ2e0aeg2AGA/j.OXW";

    expect(bcrypt.getRounds(stored)).toBe(10);
    await expect(bcrypt.compare("password", stored)).resolves.toBe(true);
    await expect(bcrypt.compare("Password", stored)).resolves.toBe(false);
  });

  it("caps the synchronous API and genSalt the same way", () => {
    expect(bcrypt.getRounds(bcrypt.hashSync("x", 12))).toBe(4);
    expect(bcrypt.getRounds(bcrypt.genSaltSync(12))).toBe(4);
  });
});
