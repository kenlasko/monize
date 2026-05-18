import { Reflector } from "@nestjs/core";
import {
  AllowDelegate,
  DelegatedAccountParam,
  DelegatedTransactionParam,
  DelegatedTransferBody,
  DelegatedTransferParam,
  DelegateRequires,
  ALLOW_DELEGATE_KEY,
  DELEGATED_ACCOUNT_PARAM_KEY,
  DELEGATED_TRANSACTION_PARAM_KEY,
  DELEGATED_TRANSFER_BODY_KEY,
  DELEGATED_TRANSFER_PARAM_KEY,
  DELEGATE_OPERATION_KEY,
} from "./delegate-access.decorator";

describe("delegate-access decorators", () => {
  const reflector = new Reflector();

  it("AllowDelegate sets the allow-delegate metadata", () => {
    class C {
      @AllowDelegate()
      handler() {}
    }
    expect(reflector.get(ALLOW_DELEGATE_KEY, C.prototype.handler)).toBe(true);
  });

  it("DelegatedAccountParam defaults to 'id'", () => {
    class C {
      @DelegatedAccountParam()
      handler() {}
    }
    expect(
      reflector.get(DELEGATED_ACCOUNT_PARAM_KEY, C.prototype.handler),
    ).toBe("id");
  });

  it("DelegatedAccountParam accepts a custom key", () => {
    class C {
      @DelegatedAccountParam("accountId")
      handler() {}
    }
    expect(
      reflector.get(DELEGATED_ACCOUNT_PARAM_KEY, C.prototype.handler),
    ).toBe("accountId");
  });

  it("DelegateRequires sets the required operation", () => {
    class C {
      @DelegateRequires("create")
      handler() {}
    }
    expect(reflector.get(DELEGATE_OPERATION_KEY, C.prototype.handler)).toBe(
      "create",
    );
  });

  it("DelegatedTransactionParam sets the transaction-id key", () => {
    class C {
      @DelegatedTransactionParam()
      handler() {}
    }
    expect(
      reflector.get(DELEGATED_TRANSACTION_PARAM_KEY, C.prototype.handler),
    ).toBe("id");
  });

  it("DelegatedTransferBody sets [fromKey, toKey]", () => {
    class C {
      @DelegatedTransferBody()
      handler() {}
    }
    expect(
      reflector.get(DELEGATED_TRANSFER_BODY_KEY, C.prototype.handler),
    ).toEqual(["fromAccountId", "toAccountId"]);
  });

  it("DelegatedTransferParam sets the transfer-id key", () => {
    class C {
      @DelegatedTransferParam()
      handler() {}
    }
    expect(
      reflector.get(DELEGATED_TRANSFER_PARAM_KEY, C.prototype.handler),
    ).toBe("id");
  });
});
