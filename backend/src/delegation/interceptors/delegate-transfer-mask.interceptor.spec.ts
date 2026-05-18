import { of, lastValueFrom } from "rxjs";
import { DelegateTransferMaskInterceptor } from "./delegate-transfer-mask.interceptor";

describe("DelegateTransferMaskInterceptor", () => {
  let interceptor: DelegateTransferMaskInterceptor;
  let delegationService: Record<string, jest.Mock>;

  const ctxFor = (user: any) =>
    ({
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;
  const handlerOf = (body: unknown) => ({ handle: () => of(body) }) as any;

  beforeEach(() => {
    delegationService = { readableAccountIds: jest.fn() };
    interceptor = new DelegateTransferMaskInterceptor(delegationService as any);
  });

  it("passes through for a non-delegate request", async () => {
    const body = [{ id: "t1", isTransfer: true }];
    const out = await lastValueFrom(
      interceptor.intercept(ctxFor({ isActing: false }), handlerOf(body)),
    );
    expect(out).toBe(body);
    expect(delegationService.readableAccountIds).not.toHaveBeenCalled();
  });

  it("masks a transfer counterpart the delegate cannot READ", async () => {
    delegationService.readableAccountIds.mockResolvedValue(["a1"]);
    const body = {
      data: [
        {
          id: "t1",
          isTransfer: true,
          payeeName: "Transfer to Savings",
          linkedTransaction: {
            accountId: "a2",
            account: { id: "a2", name: "Savings" },
          },
        },
      ],
    };
    const out: any = await lastValueFrom(
      interceptor.intercept(
        ctxFor({ isActing: true, delegationId: "g1" }),
        handlerOf(body),
      ),
    );
    expect(out.data[0].linkedTransaction.account).toEqual({
      id: "a2",
      name: "Hidden account",
    });
    expect(out.data[0].payeeName).toBe("Transfer to Hidden account");
  });

  it("does not mask when the counterpart is readable", async () => {
    delegationService.readableAccountIds.mockResolvedValue(["a1", "a2"]);
    const body = [
      {
        id: "t1",
        isTransfer: true,
        payeeName: "Transfer to Savings",
        linkedTransaction: {
          accountId: "a2",
          account: { id: "a2", name: "Savings" },
        },
      },
    ];
    const out: any = await lastValueFrom(
      interceptor.intercept(
        ctxFor({ isActing: true, delegationId: "g1" }),
        handlerOf(body),
      ),
    );
    expect(out[0].linkedTransaction.account.name).toBe("Savings");
    expect(out[0].payeeName).toBe("Transfer to Savings");
  });

  it("masks a single transaction object and ignores non-transfers", async () => {
    delegationService.readableAccountIds.mockResolvedValue([]);
    const body = {
      id: "t1",
      isTransfer: true,
      payeeName: "Transfer from Chequing",
      linkedTransaction: {
        accountId: "a9",
        account: { id: "a9", name: "Chequing" },
      },
    };
    const out: any = await lastValueFrom(
      interceptor.intercept(
        ctxFor({ isActing: true, delegationId: "g1" }),
        handlerOf(body),
      ),
    );
    expect(out.linkedTransaction.account.name).toBe("Hidden account");
    expect(out.payeeName).toBe("Transfer from Hidden account");
  });
});
