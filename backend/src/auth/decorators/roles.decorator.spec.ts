import { ROLES_KEY } from "../guards/roles.guard";
import { Roles } from "./roles.decorator";

describe("Roles decorator", () => {
  it("sets correct metadata with ROLES_KEY for a single role", () => {
    @Roles("admin")
    class TestClass {}

    const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
    expect(roles).toEqual(["admin"]);
  });

  it("sets correct metadata with ROLES_KEY for multiple roles", () => {
    @Roles("admin", "moderator")
    class TestClass {}

    const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
    expect(roles).toEqual(["admin", "moderator"]);
  });

  it("sets an empty array when no roles are provided", () => {
    @Roles()
    class TestClass {}

    const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
    expect(roles).toEqual([]);
  });

  it("works as a method decorator", () => {
    class TestClass {
      @Roles("admin")
      someMethod() {}
    }

    const roles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.someMethod);
    expect(roles).toEqual(["admin"]);
  });
});
