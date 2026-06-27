import { AiActionBuilderService } from "./ai-action-builder.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import {
  CategorizeTransactionPreview,
  CreateTransactionPreview,
  UpdateTransactionPreview,
  DeleteTransactionPreview,
} from "../../transactions/transactions.service";
import { CreatePayeePreview } from "../../payees/payees.service";
import {
  CreateInvestmentTransactionPreview,
  UpdateInvestmentTransactionPreview,
  DeleteInvestmentTransactionPreview,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";

describe("AiActionBuilderService", () => {
  let builder: AiActionBuilderService;
  let signing: { sign: jest.Mock };

  beforeEach(() => {
    signing = { sign: jest.fn().mockReturnValue("sig-123") };
    builder = new AiActionBuilderService(
      signing as unknown as AiActionSigningService,
    );
  });

  it("builds a signed create_transaction action from a preview", () => {
    const preview: CreateTransactionPreview = {
      accountId: "a1",
      accountName: "Checking",
      amount: -50,
      transactionDate: "2025-01-15",
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: "c1",
      categoryName: "Groceries",
      description: "weekly shop",
      currencyCode: "USD",
    };

    const action = builder.buildCreateTransaction("u1", preview);

    expect(action.type).toBe("create_transaction");
    expect(action.signature).toBe("sig-123");
    expect(action.expiresAt).toBeGreaterThan(Date.now());
    expect(action.descriptor).toMatchObject({
      type: "create_transaction",
      userId: "u1",
      accountId: "a1",
      amount: -50,
      payeeId: "p1",
      createPayee: false,
      categoryId: "c1",
      currencyCode: "USD",
    });
    // The descriptor (not the preview) is what gets signed.
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
    expect(action.preview).toMatchObject({
      accountName: "Checking",
      amount: -50,
      categoryName: "Groceries",
    });
  });

  it("builds a categorize_transaction action and omits a null account name", () => {
    const preview: CategorizeTransactionPreview = {
      transactionId: "t1",
      payeeName: null,
      amount: 12,
      transactionDate: "2025-02-01",
      accountName: null,
      currentCategoryName: null,
      categoryId: "c2",
      newCategoryName: "Dining",
    };

    const action = builder.buildCategorizeTransaction("u1", preview);

    expect(action.type).toBe("categorize_transaction");
    expect(action.descriptor).toMatchObject({
      type: "categorize_transaction",
      userId: "u1",
      transactionId: "t1",
      categoryId: "c2",
    });
    expect(action.preview.accountName).toBeUndefined();
    expect(action.preview.newCategoryName).toBe("Dining");
  });

  it("builds a create_payee action", () => {
    const preview: CreatePayeePreview = {
      name: "Hydro",
      defaultCategoryId: "c3",
      defaultCategoryName: "Utilities",
    };

    const action = builder.buildCreatePayee("u1", preview);

    expect(action.type).toBe("create_payee");
    expect(action.descriptor).toMatchObject({
      type: "create_payee",
      userId: "u1",
      name: "Hydro",
      defaultCategoryId: "c3",
    });
    expect(action.preview).toMatchObject({
      name: "Hydro",
      categoryName: "Utilities",
    });
  });

  it("builds an update_payee action", () => {
    const action = builder.buildUpdatePayee("u1", {
      payeeId: "p9",
      name: "Hydro One",
      defaultCategoryId: "c3",
      defaultCategoryName: "Utilities",
    });

    expect(action.type).toBe("update_payee");
    expect(action.descriptor).toMatchObject({
      type: "update_payee",
      userId: "u1",
      payeeId: "p9",
      name: "Hydro One",
      defaultCategoryId: "c3",
    });
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
    expect(action.preview).toMatchObject({
      name: "Hydro One",
      categoryName: "Utilities",
    });
  });

  it("builds a delete_payee action", () => {
    const action = builder.buildDeletePayee("u1", {
      payeeId: "p9",
      name: "Hydro",
    });

    expect(action.type).toBe("delete_payee");
    expect(action.descriptor).toMatchObject({
      type: "delete_payee",
      userId: "u1",
      payeeId: "p9",
    });
    expect(action.preview).toMatchObject({ name: "Hydro" });
  });

  it("builds a create_security action from a preview", () => {
    const preview = {
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: true,
      quoteProvider: "yahoo" as const,
      msnInstrumentId: null,
    };

    const action = builder.buildCreateSecurity("u1", preview);

    expect(action.type).toBe("create_security");
    expect(action.descriptor).toMatchObject({
      type: "create_security",
      userId: "u1",
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: true,
      quoteProvider: "yahoo",
    });
    // The descriptor (not the preview) is what gets signed.
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
    expect(action.preview).toMatchObject({
      symbol: "AAPL",
      securityName: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      securityCurrency: "USD",
      isFavourite: true,
    });
  });

  it("builds an update_security action", () => {
    const action = builder.buildUpdateSecurity("u1", {
      securityId: "s9",
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "ETF",
      exchange: "NYSE",
      currencyCode: "USD",
      isFavourite: true,
      countryWeightings: null,
    });

    expect(action.type).toBe("update_security");
    expect(action.descriptor).toMatchObject({
      type: "update_security",
      userId: "u1",
      securityId: "s9",
      securityType: "ETF",
      exchange: "NYSE",
      currencyCode: "USD",
      isFavourite: true,
    });
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
    expect(action.preview).toMatchObject({
      symbol: "AAPL",
      securityName: "Apple Inc.",
      securityType: "ETF",
    });
  });

  it("builds a delete_security action", () => {
    const action = builder.buildDeleteSecurity("u1", {
      securityId: "s9",
      symbol: "AAPL",
      name: "Apple Inc.",
    });

    expect(action.type).toBe("delete_security");
    expect(action.descriptor).toMatchObject({
      type: "delete_security",
      userId: "u1",
      securityId: "s9",
    });
    expect(action.preview).toMatchObject({
      symbol: "AAPL",
      securityName: "Apple Inc.",
    });
  });

  it("builds a create_investment_transaction action", () => {
    const preview: CreateInvestmentTransactionPreview = {
      accountId: "acc1",
      accountName: "Brokerage",
      accountCurrency: "USD",
      action: InvestmentAction.BUY,
      transactionDate: "2025-03-03",
      securityId: "s1",
      symbol: "VTI",
      securityName: "Vanguard Total",
      securityCurrency: "USD",
      fundingAccountId: null,
      quantity: 10,
      price: 200,
      commission: 1,
      exchangeRate: 1,
      totalAmount: 2001,
      cashAccountName: "Brokerage Cash",
      cashCurrency: "USD",
      cashAmount: -2001,
      description: null,
    };

    const action = builder.buildCreateInvestmentTransaction("u1", preview);

    expect(action.type).toBe("create_investment_transaction");
    expect(action.descriptor).toMatchObject({
      type: "create_investment_transaction",
      userId: "u1",
      accountId: "acc1",
      action: InvestmentAction.BUY,
      securityId: "s1",
      exchangeRate: 1,
    });
    expect(action.preview).toMatchObject({
      symbol: "VTI",
      investmentAction: InvestmentAction.BUY,
      totalAmount: 2001,
    });
  });

  it("builds a bulk create_transactions action: signed rows are the valid ones, preview rows include flagged", () => {
    const ok: CreateTransactionPreview = {
      accountId: "a1",
      accountName: "Checking",
      amount: -50,
      transactionDate: "2025-01-15",
      payeeId: null,
      payeeName: "Store",
      payeeMatched: false,
      payeeWillBeCreated: true,
      categoryId: "c1",
      categoryName: "Groceries",
      description: null,
      currencyCode: "USD",
    };
    const previewRows = [
      {
        status: "ok" as const,
        accountName: "Checking",
        amount: -50,
        payeeName: "Store",
      },
      {
        status: "error" as const,
        accountName: "Nope",
        error: "Unknown account: Nope",
      },
    ];

    const action = builder.buildCreateTransactions("u1", [ok], previewRows);

    expect(action.type).toBe("create_transactions");
    expect(action.descriptor.type).toBe("create_transactions");
    if (action.descriptor.type !== "create_transactions") throw new Error();
    // Only the valid row is signed into the descriptor.
    expect(action.descriptor.rows).toHaveLength(1);
    expect(action.descriptor.rows[0]).toMatchObject({
      accountId: "a1",
      amount: -50,
      createPayee: true,
      currencyCode: "USD",
    });
    // The display preview keeps both rows in pasted order.
    expect(action.preview.rows).toHaveLength(2);
    expect(action.preview.rows?.[1].status).toBe("error");
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
  });

  it("builds a bulk create_investment_transactions action", () => {
    const ok: CreateInvestmentTransactionPreview = {
      accountId: "acc1",
      accountName: "Brokerage",
      accountCurrency: "USD",
      action: InvestmentAction.BUY,
      transactionDate: "2025-03-03",
      securityId: "s1",
      symbol: "VTI",
      securityName: "Vanguard Total",
      securityCurrency: "USD",
      fundingAccountId: null,
      quantity: 10,
      price: 200,
      commission: 1,
      exchangeRate: 1,
      totalAmount: 2001,
      cashAccountName: "Brokerage Cash",
      cashCurrency: "USD",
      cashAmount: -2001,
      description: null,
    };

    const action = builder.buildCreateInvestmentTransactions(
      "u1",
      [ok],
      [{ status: "ok", symbol: "VTI" }],
    );

    expect(action.type).toBe("create_investment_transactions");
    if (action.descriptor.type !== "create_investment_transactions")
      throw new Error();
    expect(action.descriptor.rows).toHaveLength(1);
    expect(action.descriptor.rows[0]).toMatchObject({
      accountId: "acc1",
      action: InvestmentAction.BUY,
      securityId: "s1",
      exchangeRate: 1,
    });
    expect(action.preview.rows).toHaveLength(1);
  });

  it("builds an update_transaction action carrying the full resulting state", () => {
    const preview: UpdateTransactionPreview = {
      transactionId: "t1",
      accountId: "a1",
      accountName: "Checking",
      amount: -75,
      transactionDate: "2025-04-01",
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: "c1",
      categoryName: "Groceries",
      description: "edited",
      currencyCode: "USD",
      isReconciled: true,
    };

    const action = builder.buildUpdateTransaction("u1", preview);

    expect(action.type).toBe("update_transaction");
    expect(action.descriptor).toMatchObject({
      type: "update_transaction",
      userId: "u1",
      transactionId: "t1",
      accountId: "a1",
      amount: -75,
      payeeId: "p1",
      createPayee: false,
      categoryId: "c1",
      currencyCode: "USD",
    });
    expect(signing.sign).toHaveBeenCalledWith(action.descriptor);
    expect(action.preview).toMatchObject({
      accountName: "Checking",
      amount: -75,
      categoryName: "Groceries",
      description: "edited",
      // Reconciled status is surfaced on the card so the user is warned.
      isReconciled: true,
    });
  });

  it("builds a delete_transaction action with only the target id signed", () => {
    const preview: DeleteTransactionPreview = {
      transactionId: "t9",
      accountName: "Checking",
      amount: -20,
      transactionDate: "2025-04-02",
      payeeName: "Cafe",
      categoryName: "Dining",
      description: null,
      currencyCode: "USD",
      isReconciled: true,
    };

    const action = builder.buildDeleteTransaction("u1", preview);

    expect(action.type).toBe("delete_transaction");
    expect(action.descriptor).toMatchObject({
      type: "delete_transaction",
      userId: "u1",
      transactionId: "t9",
    });
    expect(action.preview).toMatchObject({
      accountName: "Checking",
      amount: -20,
      payeeName: "Cafe",
      isReconciled: true,
    });
  });

  it("builds an update_investment_transaction action", () => {
    const preview: UpdateInvestmentTransactionPreview = {
      transactionId: "it1",
      accountId: "acc1",
      accountName: "Brokerage",
      accountCurrency: "USD",
      action: InvestmentAction.SELL,
      transactionDate: "2025-03-03",
      securityId: "s1",
      symbol: "VTI",
      securityName: "Vanguard Total",
      securityCurrency: "USD",
      fundingAccountId: null,
      quantity: 5,
      price: 210,
      commission: 1,
      exchangeRate: 1,
      totalAmount: 1049,
      cashAccountName: "Brokerage Cash",
      cashCurrency: "USD",
      cashAmount: 1049,
      description: null,
    };

    const action = builder.buildUpdateInvestmentTransaction("u1", preview);

    expect(action.type).toBe("update_investment_transaction");
    expect(action.descriptor).toMatchObject({
      type: "update_investment_transaction",
      userId: "u1",
      transactionId: "it1",
      accountId: "acc1",
      action: InvestmentAction.SELL,
      securityId: "s1",
      exchangeRate: 1,
    });
    expect(action.preview).toMatchObject({
      symbol: "VTI",
      investmentAction: InvestmentAction.SELL,
      totalAmount: 1049,
    });
  });

  it("builds a delete_investment_transaction action", () => {
    const preview: DeleteInvestmentTransactionPreview = {
      transactionId: "it9",
      accountName: "Brokerage",
      action: InvestmentAction.BUY,
      transactionDate: "2025-03-03",
      symbol: "VTI",
      securityName: "Vanguard Total",
      securityCurrency: "USD",
      quantity: 10,
      price: 200,
      commission: 1,
      totalAmount: 2001,
      description: null,
    };

    const action = builder.buildDeleteInvestmentTransaction("u1", preview);

    expect(action.type).toBe("delete_investment_transaction");
    expect(action.descriptor).toMatchObject({
      type: "delete_investment_transaction",
      userId: "u1",
      transactionId: "it9",
    });
    expect(action.preview).toMatchObject({
      symbol: "VTI",
      investmentAction: InvestmentAction.BUY,
      totalAmount: 2001,
    });
  });

  it("builds a signed create_transfer action and preview", () => {
    const preview = {
      fromAccountId: "a1",
      fromAccountName: "Checking",
      fromCurrencyCode: "USD",
      toAccountId: "a2",
      toAccountName: "Savings",
      toCurrencyCode: "USD",
      amount: 100,
      toAmount: 100,
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: null,
      payeeId: "payee-1",
      payeeName: "Custom transfer label",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: "cat-1",
      categoryName: "Savings Goal",
    };
    const action = builder.buildCreateTransfer("user-1", preview);
    expect(action.type).toBe("create_transfer");
    expect(action.signature).toBe("sig-123");
    expect(action.descriptor).toMatchObject({
      type: "create_transfer",
      userId: "user-1",
      fromAccountId: "a1",
      toAccountId: "a2",
      amount: 100,
      toAmount: 100,
      payeeId: "payee-1",
      payeeName: "Custom transfer label",
      createPayee: false,
      categoryId: "cat-1",
    });
    expect(action.preview).toMatchObject({
      fromAccountName: "Checking",
      toAccountName: "Savings",
      toAmount: 100,
      payeeName: "Custom transfer label",
      payeeWillBeCreated: false,
      categoryName: "Savings Goal",
    });
  });

  it("carries payeeId=null and createPayee=true for an unmatched transfer label", () => {
    const action = builder.buildCreateTransfer("user-1", {
      fromAccountId: "a1",
      fromAccountName: "Checking",
      fromCurrencyCode: "USD",
      toAccountId: "a2",
      toAccountName: "Savings",
      toCurrencyCode: "USD",
      amount: 100,
      toAmount: 100,
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: null,
      payeeId: null,
      payeeName: "Brand new label",
      payeeMatched: false,
      payeeWillBeCreated: true,
      categoryId: null,
      categoryName: null,
    });
    expect(action.descriptor).toMatchObject({
      type: "create_transfer",
      payeeId: null,
      payeeName: "Brand new label",
      createPayee: true,
      categoryId: null,
    });
    expect(action.preview).toMatchObject({ payeeWillBeCreated: true });
  });

  it("builds a signed update_transfer action carrying the category", () => {
    const action = builder.buildUpdateTransfer("user-1", {
      transactionId: "t1",
      fromAccountId: "a1",
      fromAccountName: "Checking",
      fromCurrencyCode: "USD",
      toAccountId: "a2",
      toAccountName: "Savings",
      toCurrencyCode: "USD",
      amount: 200,
      toAmount: 200,
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: null,
      payeeId: "payee-2",
      payeeName: "Edited transfer label",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: "cat-1",
      categoryName: "Investments: IKE",
    });
    expect(action.type).toBe("update_transfer");
    expect(action.descriptor).toMatchObject({
      type: "update_transfer",
      transactionId: "t1",
      amount: 200,
      payeeId: "payee-2",
      payeeName: "Edited transfer label",
      createPayee: false,
      categoryId: "cat-1",
    });
    expect(action.preview).toMatchObject({
      payeeName: "Edited transfer label",
      payeeWillBeCreated: false,
      categoryName: "Investments: IKE",
    });
  });

  it("builds a signed batch_actions envelope carrying rows and preview rows", () => {
    const rows = [{ transactionId: "t1" }, { transactionId: "t2" }];
    const previewRows = [{ status: "ok" as const }, { status: "ok" as const }];
    const action = builder.buildBatchActions(
      "user-1",
      "delete",
      rows as never,
      previewRows,
    );
    expect(action.type).toBe("batch_actions");
    expect(action.descriptor).toMatchObject({
      type: "batch_actions",
      operation: "delete",
      rows,
    });
    expect(action.preview.rows).toHaveLength(2);
  });

  it("builds a batch_actions(update_investment) envelope via the investment sibling builder", () => {
    const rows = [
      {
        transactionId: "it1",
        accountId: "a1",
        action: "SELL",
        transactionDate: "2026-02-01",
        securityId: "s1",
        fundingAccountId: null,
        quantity: 5,
        price: 160,
        commission: 0,
        exchangeRate: 1,
        description: null,
      },
    ];
    const previewRows = [{ status: "ok" as const, symbol: "VTI" }];
    const action = builder.buildBatchUpdateInvestmentTransactions(
      "user-1",
      rows as never,
      previewRows,
    );
    expect(action.type).toBe("batch_actions");
    expect(action.signature).toBe("sig-123");
    expect(action.descriptor).toMatchObject({
      type: "batch_actions",
      operation: "update_investment",
      rows,
    });
    expect(action.preview.rows).toHaveLength(1);
  });

  it("builds a batch_actions(delete_investment) envelope via the investment sibling builder", () => {
    const rows = [{ transactionId: "it1" }, { transactionId: "it2" }];
    const previewRows = [{ status: "ok" as const }, { status: "ok" as const }];
    const action = builder.buildBatchDeleteInvestmentTransactions(
      "user-1",
      rows as never,
      previewRows,
    );
    expect(action.descriptor).toMatchObject({
      type: "batch_actions",
      operation: "delete_investment",
      rows,
    });
    expect(action.preview.rows).toHaveLength(2);
  });

  it("transferPreviewRow maps a transfer preview to a display row", () => {
    const {
      transferPreviewRow,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("./ai-action-builder.service");
    const row = transferPreviewRow({
      fromAccountId: "a1",
      fromAccountName: "Checking",
      fromCurrencyCode: "USD",
      toAccountId: "a2",
      toAccountName: "Savings",
      toCurrencyCode: "USD",
      amount: 100,
      toAmount: 100,
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: null,
      payeeId: null,
      payeeName: "Row label",
      payeeMatched: false,
      payeeWillBeCreated: true,
    });
    expect(row).toMatchObject({
      status: "ok",
      accountName: "Checking",
      toAccountName: "Savings",
      toAmount: 100,
      payeeName: "Row label",
      payeeWillBeCreated: true,
    });
  });
});
