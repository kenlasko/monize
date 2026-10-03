import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsController } from "@/transactions/transactions.controller";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { JointRegisterService } from "@/transactions/joint-register.service";
import { JointCategoriesService } from "@/categories/joint-categories.service";
import { CategoriesModule } from "@/categories/categories.module";
import { Category } from "@/categories/entities/category.entity";
import { JointAccountsService } from "@/delegation/joint-accounts.service";
import { DelegationService } from "@/delegation/delegation.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { User } from "@/users/entities/user.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * V1/W2 of the joint-accounts plan: the whole native lifecycle over a real
 * database. Owner "Alice" shares an account jointly with grantee "Bob"; Bob
 * reads and writes it from his OWN context (no acting switch). Covers the
 * enriched native rows, the write cycle (rows land on the owner's ledger,
 * balances atomically), the refusal matrix (no partial writes), the grantee
 * net-worth scope with the exclusion overlay, transfer freeze/reconnect on
 * revoke/re-grant, and the revoke-never-deletes-a-real-user regression.
 */
describe("Joint accounts (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let transactions: TransactionsService;
  let jointRegister: JointRegisterService;
  let jointCategories: JointCategoriesService;
  let jointAccounts: JointAccountsService;
  let delegationService: DelegationService;
  let netWorth: NetWorthService;
  let dataSource: DataSource;

  let ownerId: string; // Alice -- owns the joint account
  let granteeId: string; // Bob -- full account of his own
  let jointAccountId: string;
  let granteeAccountId: string;
  let delegationId: string;

  async function createDelegation(): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [ownerId, granteeId],
    );
    return row.id;
  }

  async function grantJoint(flags: {
    create?: boolean;
    edit?: boolean;
    del?: boolean;
    joint?: boolean;
  }): Promise<void> {
    await dataSource.query(
      `DELETE FROM account_delegate_grants
        WHERE delegation_id = $1 AND account_id = $2`,
      [delegationId, jointAccountId],
    );
    await dataSource.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, can_create, can_edit, can_delete, is_joint)
       VALUES ($1, $2, true, $3, $4, $5, $6)`,
      [
        delegationId,
        jointAccountId,
        flags.create ?? false,
        flags.edit ?? false,
        flags.del ?? false,
        flags.joint ?? true,
      ],
    );
  }

  /** The per-delegation manage capability, independent of the account grants. */
  async function setCategoryCapability(granted: boolean): Promise<void> {
    await dataSource.query(
      `UPDATE account_delegates SET categories_can_create = $2 WHERE id = $1`,
      [delegationId, granted],
    );
  }

  /** Hard-delete the delegation, exactly like revoke does (FK removes grants). */
  async function unshare(): Promise<void> {
    await dataSource.query(`DELETE FROM account_delegates WHERE id = $1`, [
      delegationId,
    ]);
  }

  async function reshare(flags: {
    create?: boolean;
    edit?: boolean;
    del?: boolean;
  }): Promise<void> {
    delegationId = await createDelegation();
    await grantJoint({ ...flags, joint: true });
  }

  async function loadAccount(id: string): Promise<Account> {
    return (await dataSource.manager.findOne(Account, { where: { id } }))!;
  }

  async function ownerCategory(name = "Groceries"): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO categories (user_id, name) VALUES ($1, $2) RETURNING id`,
      [ownerId, name],
    );
    return row.id;
  }

  async function granteeCategory(): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO categories (user_id, name) VALUES ($1, 'Bob Private') RETURNING id`,
      [granteeId],
    );
    return row.id;
  }

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
      CategoriesModule,
    ]);
    transactions = module.get(TransactionsService);
    jointRegister = module.get(JointRegisterService);
    jointCategories = module.get(JointCategoriesService);
    jointAccounts = module.get(JointAccountsService);
    delegationService = module.get(DelegationService);
    netWorth = module.get(NetWorthService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "delegate_net_worth_exclusions",
      "account_delegate_grants",
      "account_delegates",
      "tags",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    const owner = await createTestUserDirect(dataSource, {
      firstName: "Alice",
      lastName: "Owner",
    });
    ownerId = owner.id;
    const grantee = await createTestUserDirect(dataSource, {
      firstName: "Bob",
      lastName: "Grantee",
    });
    granteeId = grantee.id;

    jointAccountId = (
      await createTestAccount(dataSource, ownerId, {
        name: "Household Chequing",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    granteeAccountId = (
      await createTestAccount(dataSource, granteeId, {
        name: "Bob Savings",
        openingBalance: 2000,
        currentBalance: 2000,
      })
    ).id;

    delegationId = await createDelegation();
  });

  describe("native visibility (union rows)", () => {
    it("returns the enriched joint row for a joint grant", async () => {
      await grantJoint({ create: true, edit: true });
      const rows = await withUserContext(granteeId, () =>
        jointAccounts.jointAccountsFor(granteeId),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: jointAccountId,
        isJoint: true,
        ownerLabel: "Alice Owner",
        jointPermissions: { canCreate: true, canEdit: true, canDelete: false },
        excludeFromNetWorth: false,
        canDelete: false,
      });
      expect(Number(rows[0].currentBalance)).toBe(5000);
    });

    it("never surfaces a plain (non-joint) grant natively", async () => {
      await grantJoint({ create: true, joint: false });
      const rows = await withUserContext(granteeId, () =>
        jointAccounts.jointAccountsFor(granteeId),
      );
      expect(rows).toHaveLength(0);
      await expect(
        withUserContext(granteeId, () =>
          jointAccounts.jointAccessFor(granteeId, jointAccountId, "read"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("drops the row cleanly on revoke and restores it on re-grant", async () => {
      await grantJoint({});
      await unshare();
      expect(
        await withUserContext(granteeId, () =>
          jointAccounts.jointAccountsFor(granteeId),
        ),
      ).toHaveLength(0);

      await reshare({});
      const restored = await withUserContext(granteeId, () =>
        jointAccounts.jointAccountsFor(granteeId),
      );
      expect(restored.map((r) => r.id)).toEqual([jointAccountId]);
    });
  });

  describe("native register writes (owner's ledger)", () => {
    it("creates the row AS THE OWNER and moves the owner's balance atomically", async () => {
      await grantJoint({ create: true });
      const categoryId = await ownerCategory();

      const created = await withUserContext(granteeId, () =>
        jointRegister.create(granteeId, {
          accountId: jointAccountId,
          amount: -150,
          transactionDate: "2026-01-10",
          currencyCode: "USD",
          categoryId,
          payeeName: undefined,
        } as never),
      );

      const row = (await dataSource.manager.findOne(Transaction, {
        where: { id: created.id },
      }))!;
      expect(row.userId).toBe(ownerId); // per-row ownership invariant
      expect(row.accountId).toBe(jointAccountId);
      const account = await loadAccount(jointAccountId);
      expect(Number(account.currentBalance)).toBe(4850);
    });

    it("refuses a create without the grant flag and writes NOTHING", async () => {
      await grantJoint({}); // read-only joint
      await expect(
        withUserContext(granteeId, () =>
          jointRegister.create(granteeId, {
            accountId: jointAccountId,
            amount: -150,
            transactionDate: "2026-01-10",
            currencyCode: "USD",
          } as never),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await dataSource.manager.count(Transaction, {
          where: { accountId: jointAccountId },
        }),
      ).toBe(0);
      expect(Number((await loadAccount(jointAccountId)).currentBalance)).toBe(
        5000,
      );
    });

    it("refuses the grantee's own category id on an owner row with no partial write", async () => {
      await grantJoint({ create: true });
      const foreignCategory = await granteeCategory();
      await expect(
        withUserContext(granteeId, () =>
          jointRegister.create(granteeId, {
            accountId: jointAccountId,
            amount: -25,
            transactionDate: "2026-01-11",
            currencyCode: "USD",
            categoryId: foreignCategory,
          } as never),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await dataSource.manager.count(Transaction, {
          where: { accountId: jointAccountId },
        }),
      ).toBe(0);
    });

    it("edits and deletes through the joint path, reversing the owner's balance", async () => {
      await grantJoint({ create: true, edit: true, del: true });
      const created = await withUserContext(granteeId, () =>
        jointRegister.create(granteeId, {
          accountId: jointAccountId,
          amount: -100,
          transactionDate: "2026-01-12",
          currencyCode: "USD",
        } as never),
      );

      await withUserContext(granteeId, () =>
        jointRegister.update(granteeId, created.id, { amount: -250 } as never),
      );
      expect(Number((await loadAccount(jointAccountId)).currentBalance)).toBe(
        4750,
      );

      await withUserContext(granteeId, () =>
        jointRegister.remove(granteeId, created.id),
      );
      expect(
        await dataSource.manager.findOne(Transaction, {
          where: { id: created.id },
        }),
      ).toBeNull();
      expect(Number((await loadAccount(jointAccountId)).currentBalance)).toBe(
        5000,
      );
    });

    it("rejects grantee tags and splits before any write", async () => {
      await grantJoint({ create: true });
      for (const dto of [
        { tagIds: ["11111111-1111-4111-8111-111111111111"] },
        { splits: [{ amount: -10 }] },
      ]) {
        await expect(
          withUserContext(granteeId, () =>
            jointRegister.create(granteeId, {
              accountId: jointAccountId,
              amount: -10,
              transactionDate: "2026-01-13",
              currencyCode: "USD",
              ...dto,
            } as never),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(
        await dataSource.manager.count(Transaction, {
          where: { accountId: jointAccountId },
        }),
      ).toBe(0);
    });
  });

  // The capability existed on both sides -- stored, editable by the owner,
  // reported in the joint reference data -- and reached no endpoint, so a
  // grantee holding it still could not create a category.
  describe("the owner's structural rules on a grantee's create", () => {
    it("skips convert_to_transfer and split: no counterpart, no owner balance change, no owner account in the response", async () => {
      await grantJoint({ create: true });
      const mortgageId = (
        await createTestAccount(dataSource, ownerId, {
          name: "Private Mortgage",
          accountType: "LOAN",
          openingBalance: -20000,
          currentBalance: -20000,
        })
      ).id;
      const loansCategory = await ownerCategory("Loans");
      const rules = module.get(TransactionRulesService, { strict: false });
      const matches = {
        field: "description",
        op: "contains",
        value: "LOAN-0000",
      };
      await withUserContext(ownerId, async () => {
        await rules.create(ownerId, {
          name: "Principal",
          triggers: ["create"],
          condition: matches,
          actions: [
            {
              type: "convert_to_transfer",
              toAccountId: mortgageId,
              clearCategory: true,
            },
          ],
        } as never);
        await rules.create(ownerId, {
          name: "Principal split",
          triggers: ["create"],
          condition: {
            field: "description",
            op: "matches",
            value: "LOAN-0000 {principal}/{interest}",
          },
          actions: [
            {
              type: "split",
              parts: [
                { amount: "{principal}", transferAccountId: mortgageId },
                { amount: "{interest}", categoryId: loansCategory },
              ],
            },
          ],
        } as never);
        // Category rules still apply to the member's row.
        await rules.create(ownerId, {
          name: "Categorise",
          triggers: ["create"],
          condition: matches,
          actions: [
            {
              type: "set_category",
              categoryId: loansCategory,
              onlyIfEmpty: false,
            },
          ],
        } as never);
      });

      const created = await withUserContext(granteeId, () =>
        jointRegister.create(granteeId, {
          accountId: jointAccountId,
          amount: -640.15,
          transactionDate: "2026-01-10",
          currencyCode: "USD",
          description: "LOAN-0000 400,15/240,00",
        } as never),
      );

      const row = (await dataSource.manager.findOne(Transaction, {
        where: { id: created.id },
      }))!;
      // The row stays a plain expense of the owner's joint account, with the
      // category rule applied; nothing was converted or split.
      expect(row).toMatchObject({
        accountId: jointAccountId,
        isTransfer: false,
        isSplit: false,
        linkedTransactionId: null,
        categoryId: loansCategory,
      });
      expect(
        await dataSource.manager.count(Transaction, {
          where: { userId: ownerId },
        }),
      ).toBe(1);
      // The owner's private account did not move.
      expect(Number((await loadAccount(mortgageId)).currentBalance)).toBe(
        -20000,
      );
      // And the response carries no other account of the owner.
      expect(JSON.stringify(created)).not.toContain(mortgageId);
      expect(JSON.stringify(created)).not.toContain("Private Mortgage");
      expect(created.linkedTransaction ?? null).toBeNull();
      expect(created.splits ?? []).toEqual([]);
      // The trace says why.
      const traced = await dataSource.query(
        `SELECT changes FROM transaction_rule_applications WHERE transaction_id = $1`,
        [created.id],
      );
      expect(traced).toHaveLength(1);
    });

    it("an owner's own create with the same rule still converts (the flag is the grantee's only)", async () => {
      const mortgageId = (
        await createTestAccount(dataSource, ownerId, {
          name: "Private Mortgage",
          accountType: "LOAN",
          openingBalance: -20000,
          currentBalance: -20000,
        })
      ).id;
      const rules = module.get(TransactionRulesService, { strict: false });
      await withUserContext(ownerId, async () => {
        await rules.create(ownerId, {
          name: "Principal",
          triggers: ["create"],
          condition: {
            field: "description",
            op: "contains",
            value: "LOAN-0000",
          },
          actions: [
            {
              type: "convert_to_transfer",
              toAccountId: mortgageId,
              clearCategory: true,
            },
          ],
        } as never);
      });
      const created = await withUserContext(ownerId, () =>
        transactions.create(ownerId, {
          accountId: jointAccountId,
          amount: -640.15,
          transactionDate: "2026-01-10",
          currencyCode: "USD",
          description: "LOAN-0000 instalment",
        } as never),
      );
      expect(created.isTransfer).toBe(true);
      expect(Number((await loadAccount(mortgageId)).currentBalance)).toBe(
        -20000 + 640.15,
      );
    });
  });

  describe("the owner's structural rules on an acting delegate's create", () => {
    it("skips convert_to_transfer and split: no counterpart, the ungranted loan does not move, nothing of it in the response", async () => {
      // The delegate is granted Checking only (a plain, non-joint grant).
      await grantJoint({ create: true, joint: false });
      const loanId = (
        await createTestAccount(dataSource, ownerId, {
          name: "Private Mortgage",
          accountType: "LOAN",
          openingBalance: -20000,
          currentBalance: -20000,
        })
      ).id;
      const loansCategory = await ownerCategory("Loans");
      const rules = module.get(TransactionRulesService, { strict: false });
      await withUserContext(ownerId, async () => {
        await rules.create(ownerId, {
          name: "Principal",
          triggers: ["create"],
          condition: {
            field: "description",
            op: "contains",
            value: "CONVERT-0000",
          },
          actions: [
            {
              type: "convert_to_transfer",
              toAccountId: loanId,
              clearCategory: true,
            },
          ],
        } as never);
        await rules.create(ownerId, {
          name: "Principal split",
          triggers: ["create"],
          condition: {
            field: "description",
            op: "matches",
            value: "SPLIT-0000 {principal}/{interest}",
          },
          actions: [
            {
              type: "split",
              parts: [
                { amount: "{principal}", transferAccountId: loanId },
                { amount: "{interest}", categoryId: loansCategory },
              ],
            },
          ],
        } as never);
      });
      const controller = module.get(TransactionsController);
      // What the JWT strategy builds for a delegate acting as the owner.
      const actingReq = {
        user: {
          id: ownerId,
          realUserId: granteeId,
          isActing: true,
          delegationId,
        },
      };

      for (const description of [
        "CONVERT-0000 instalment",
        "SPLIT-0000 400,15/240,00",
      ]) {
        const created = await withUserContext(ownerId, () =>
          controller.create(actingReq, {
            accountId: jointAccountId,
            amount: -640.15,
            transactionDate: "2026-01-10",
            currencyCode: "USD",
            description,
          } as never),
        );
        const row = (await dataSource.manager.findOne(Transaction, {
          where: { id: created.id },
        }))!;
        expect(row).toMatchObject({
          accountId: jointAccountId,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
        expect(JSON.stringify(created)).not.toContain(loanId);
        expect(JSON.stringify(created)).not.toContain("Private Mortgage");
      }
      expect(
        await dataSource.manager.count(Transaction, {
          where: { userId: ownerId },
        }),
      ).toBe(2);
      expect(Number((await loadAccount(loanId)).currentBalance)).toBe(-20000);
    });
  });

  describe("native category creation (owner's ledger)", () => {
    it("creates the category AS THE OWNER, usable on the joint row", async () => {
      await grantJoint({ create: true });
      await setCategoryCapability(true);

      const created = await withUserContext(granteeId, () =>
        jointCategories.create(granteeId, jointAccountId, {
          name: "Daycare",
        } as never),
      );

      const row = (await dataSource.manager.findOne(Category, {
        where: { id: created.id },
      }))!;
      expect(row.userId).toBe(ownerId);
      expect(row.name).toBe("Daycare");

      // The loop closes: the id the grantee just made is the owner's, so the
      // owner-row category check accepts it where their own id is refused.
      const tx = await withUserContext(granteeId, () =>
        jointRegister.create(granteeId, {
          accountId: jointAccountId,
          amount: -60,
          transactionDate: "2026-01-12",
          currencyCode: "USD",
          categoryId: created.id,
        } as never),
      );
      expect(
        (await dataSource.manager.findOne(Transaction, {
          where: { id: tx.id },
        }))!.categoryId,
      ).toBe(created.id);
    });

    it("nests under the OWNER's parent for a Parent: Child pair", async () => {
      await grantJoint({ create: true });
      await setCategoryCapability(true);
      const parentId = await ownerCategory("Travel");

      const child = await withUserContext(granteeId, () =>
        jointCategories.create(granteeId, jointAccountId, {
          name: "Hotels",
          parentId,
        } as never),
      );

      const row = (await dataSource.manager.findOne(Category, {
        where: { id: child.id },
      }))!;
      expect(row.userId).toBe(ownerId);
      expect(row.parentId).toBe(parentId);
    });

    it("refuses without the capability and writes NOTHING", async () => {
      await grantJoint({ create: true });
      await setCategoryCapability(false);

      await expect(
        withUserContext(granteeId, () =>
          jointCategories.create(granteeId, jointAccountId, {
            name: "Daycare",
          } as never),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await dataSource.manager.count(Category, {
          where: { name: "Daycare" },
        }),
      ).toBe(0);
    });

    it("allows it on a read-only joint grant -- the capability is the write gate", async () => {
      // The account names WHICH owner's ledger is meant; it is not what
      // authorizes the write, exactly as on the acting-as POST /categories,
      // which consults no account grant at all. Keying this on the account's
      // write flags would refuse a create the owner plainly granted.
      await grantJoint({});
      await setCategoryCapability(true);

      const created = await withUserContext(granteeId, () =>
        jointCategories.create(granteeId, jointAccountId, {
          name: "Daycare",
        } as never),
      );

      expect(
        (await dataSource.manager.findOne(Category, {
          where: { id: created.id },
        }))!.userId,
      ).toBe(ownerId);
    });

    it("refuses an account that is not shared jointly, capability or not", async () => {
      await grantJoint({ create: true, joint: false });
      await setCategoryCapability(true);

      await expect(
        withUserContext(granteeId, () =>
          jointCategories.create(granteeId, jointAccountId, {
            name: "Daycare",
          } as never),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await dataSource.manager.count(Category, {
          where: { name: "Daycare" },
        }),
      ).toBe(0);
    });

    it("stops at revoke, leaving nothing written", async () => {
      await grantJoint({ create: true });
      await setCategoryCapability(true);
      await unshare();

      await expect(
        withUserContext(granteeId, () =>
          jointCategories.create(granteeId, jointAccountId, {
            name: "Daycare",
          } as never),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await dataSource.manager.count(Category, {
          where: { name: "Daycare" },
        }),
      ).toBe(0);
    });
  });

  describe("grantee net worth (N1)", () => {
    it("includes the joint account, honours the exclusion overlay, and drops on revoke", async () => {
      await grantJoint({});
      const scope = {
        accounts: [{ accountId: jointAccountId, ownerUserId: ownerId }],
      };

      // Populate both users' snapshots.
      await withUserContext(ownerId, () =>
        netWorth.recalculateAllAccounts(ownerId),
      );
      await withUserContext(granteeId, () =>
        netWorth.recalculateAllAccounts(granteeId),
      );

      const withJoint = await withUserContext(granteeId, () =>
        netWorth.getLatestNetWorth(granteeId, scope),
      );
      expect(withJoint!.netWorth).toBe(7000); // 2000 own + 5000 joint

      const withoutScope = await withUserContext(granteeId, () =>
        netWorth.getLatestNetWorth(granteeId),
      );
      expect(withoutScope!.netWorth).toBe(2000);

      // The exclusion overlay: stored per grantee, removes exactly that
      // account from the scope the controller would build.
      await withUserContext(granteeId, () =>
        jointAccounts.setNetWorthExclusion(granteeId, jointAccountId, true),
      );
      expect(
        await withUserContext(granteeId, () =>
          jointAccounts.getNetWorthExclusions(granteeId),
        ),
      ).toEqual(new Set([jointAccountId]));

      // The owner's own view is untouched throughout.
      const ownerView = await withUserContext(ownerId, () =>
        netWorth.getLatestNetWorth(ownerId),
      );
      expect(ownerView!.netWorth).toBe(5000);
    });
  });

  describe("transfers: freeze on revoke, stateless reconnect (W2)", () => {
    const actor = () => ({
      effectiveUserId: granteeId,
      realUserId: granteeId,
    });

    async function createOwnToJointTransfer(amount = 500) {
      return withUserContext(granteeId, () =>
        transactions.createTransfer(
          granteeId,
          {
            fromAccountId: granteeAccountId,
            toAccountId: jointAccountId,
            transactionDate: "2026-01-15",
            amount,
            fromCurrencyCode: "USD",
          },
          actor(),
        ),
      );
    }

    it("moves money natively between own and joint accounts with per-leg ownership", async () => {
      await grantJoint({ create: true, edit: true });
      const result = await createOwnToJointTransfer(500);

      const fromTx = (await dataSource.manager.findOne(Transaction, {
        where: { id: result.fromTransaction.id },
      }))!;
      const toTx = (await dataSource.manager.findOne(Transaction, {
        where: { id: result.toTransaction.id },
      }))!;
      expect(fromTx.userId).toBe(granteeId);
      expect(toTx.userId).toBe(ownerId);
      expect(Number((await loadAccount(granteeAccountId)).currentBalance)).toBe(
        1500,
      );
      expect(Number((await loadAccount(jointAccountId)).currentBalance)).toBe(
        5500,
      );
    });

    it("freezes the link on revoke and reconnects statelessly on re-grant", async () => {
      await grantJoint({ create: true, edit: true });
      const result = await createOwnToJointTransfer(500);

      await unshare();

      // Frozen: structural edits on the surviving own leg are locked.
      await expect(
        withUserContext(granteeId, () =>
          transactions.updateTransfer(
            granteeId,
            result.fromTransaction.id,
            { amount: 750 },
            actor(),
          ),
        ),
      ).rejects.toThrow(/no longer have access|locked/i);

      // Reshare with the joint flag re-ticked -- NO other writes in between.
      await reshare({ create: true, edit: true });

      await withUserContext(granteeId, () =>
        transactions.updateTransfer(
          granteeId,
          result.fromTransaction.id,
          { amount: 750 },
          actor(),
        ),
      );
      const toTx = (await dataSource.manager.findOne(Transaction, {
        where: { id: result.toTransaction.id },
      }))!;
      expect(Number(toTx.amount)).toBe(750);
      expect(Number((await loadAccount(jointAccountId)).currentBalance)).toBe(
        5750,
      );
    });
  });

  describe("revoke safety", () => {
    it("never deletes a grantee who owns accounts", async () => {
      await grantJoint({ create: true });
      await withUserContext(ownerId, () =>
        delegationService.revokeDelegate(ownerId, delegationId),
      );
      const grantee = await dataSource.manager.findOne(User, {
        where: { id: granteeId },
      });
      expect(grantee).not.toBeNull();
      // And their own account and its data survive untouched.
      expect(await loadAccount(granteeAccountId)).not.toBeNull();
    });
  });
});
