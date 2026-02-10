import { SKIP_CSRF_KEY, SkipCsrf } from "./skip-csrf.decorator";

describe("SkipCsrf decorator", () => {
  it("sets correct SKIP_CSRF_KEY metadata to true", () => {
    @SkipCsrf()
    class TestClass {}

    const value = Reflect.getMetadata(SKIP_CSRF_KEY, TestClass);
    expect(value).toBe(true);
  });

  it("works as a method decorator", () => {
    class TestClass {
      @SkipCsrf()
      someMethod() {}
    }

    const value = Reflect.getMetadata(
      SKIP_CSRF_KEY,
      TestClass.prototype.someMethod,
    );
    expect(value).toBe(true);
  });

  it("does not set metadata on undecorated classes", () => {
    class TestClass {}

    const value = Reflect.getMetadata(SKIP_CSRF_KEY, TestClass);
    expect(value).toBeUndefined();
  });

  it("exports SKIP_CSRF_KEY as 'skipCsrf'", () => {
    expect(SKIP_CSRF_KEY).toBe("skipCsrf");
  });
});
