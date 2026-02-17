import { DEMO_RESTRICTED_KEY } from "../guards/demo-mode.guard";
import { DemoRestricted } from "./demo-restricted.decorator";

describe("DemoRestricted decorator", () => {
  it("sets DEMO_RESTRICTED_KEY metadata to true on a method", () => {
    class TestController {
      @DemoRestricted()
      restrictedMethod() {}
    }

    const metadata = Reflect.getMetadata(
      DEMO_RESTRICTED_KEY,
      TestController.prototype.restrictedMethod,
    );
    expect(metadata).toBe(true);
  });

  it("does not set metadata on undecorated methods", () => {
    class TestController {
      unrestrictedMethod() {}
    }

    const metadata = Reflect.getMetadata(
      DEMO_RESTRICTED_KEY,
      TestController.prototype.unrestrictedMethod,
    );
    expect(metadata).toBeUndefined();
  });

  it("can be applied at class level", () => {
    @DemoRestricted()
    class TestController {}

    const metadata = Reflect.getMetadata(DEMO_RESTRICTED_KEY, TestController);
    expect(metadata).toBe(true);
  });
});
