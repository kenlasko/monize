import { DataSource } from "typeorm";

import { JobClaimService, JobClaimType } from "@/common/jobs/job-claim.service";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * Lease ownership across a rolling deployment (audit V4R3-004).
 *
 * Migration 139 gave a lease a `lease_token` and the new `release`/`markDelivered`
 * filter on it, which protects new code from new code. The previous binary names
 * the work and not the holder:
 *
 *     DELETE FROM job_claims WHERE claim_type=$1 AND user_id=$2 AND claim_key=$3
 *     UPDATE job_claims SET delivered_at=now(), expires_at=NULL WHERE <same key>
 *
 * so during a rollout a stalled old pod can delete or mark a lease a new pod has
 * retaken. Migration 139's triggers make a live tokenized lease mutable only by the
 * session that declares its token in `app.job_claim_lease_token`. This exercises the
 * literal previous-release statements against the migrated schema -- which a mocked
 * repository cannot do, because the property is the interaction between an
 * untokenized statement and the trigger.
 */
describe("job-claim lease ownership during a rolling deployment", () => {
  let dataSource: DataSource;
  let service: JobClaimService;
  let userId: string;

  const KEY = "2026-08-05#rollout";

  const claim = (): Promise<{ claim_type: string; claim_key: string }[]> =>
    dataSource.query(
      `SELECT claim_type, claim_key, lease_token, delivered_at, expires_at
         FROM job_claims WHERE user_id = $1`,
      [userId],
    );

  /** The previous binary's release: delete by work key, no token, no GUC. */
  const oldRelease = (): Promise<unknown> =>
    dataSource.query(
      `DELETE FROM job_claims
        WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3`,
      [JobClaimType.BillReminder, userId, KEY],
    );

  /** The previous binary's markDelivered: update by work key, no token, no GUC. */
  const oldMarkDelivered = (): Promise<unknown> =>
    dataSource.query(
      `UPDATE job_claims
          SET delivered_at = CURRENT_TIMESTAMP, expires_at = NULL
        WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3`,
      [JobClaimType.BillReminder, userId, KEY],
    );

  const takeLease = (): Promise<string | null> =>
    withUserContext(userId, () =>
      service.claimLease(
        JobClaimType.BillReminder,
        userId,
        KEY,
        10 * 60 * 1000,
      ),
    );

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
    service = new JobClaimService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["job_claims", "users"]);
    userId = (
      await createTestUserDirect(dataSource, { email: "lease@example.com" })
    ).id;
  });

  it("refuses a previous-release release of a live tokenized lease", async () => {
    const token = await takeLease();
    expect(token).not.toBeNull();

    // The stalled old pod resumes and releases by work key. The trigger refuses,
    // so the lease the new holder is relying on survives.
    await expect(oldRelease()).rejects.toThrow(/another attempt/i);
    expect(await claim()).toHaveLength(1);
  });

  it("refuses a previous-release delivery mark of a live tokenized lease", async () => {
    await takeLease();

    await expect(oldMarkDelivered()).rejects.toThrow(/another attempt/i);
    const [row] = await claim();
    expect(
      (row as unknown as { delivered_at: Date | null }).delivered_at,
    ).toBeNull();
  });

  it("lets the current holder release and mark its own lease", async () => {
    const token = await takeLease();

    await withUserContext(userId, () =>
      service.markDelivered(JobClaimType.BillReminder, userId, KEY, token!),
    );
    const [row] = await claim();
    expect(
      (row as unknown as { delivered_at: Date | null }).delivered_at,
    ).not.toBeNull();
  });

  it("still lets an expired lease be retaken and an old release drop a stale row", async () => {
    const token = await takeLease();
    // Age the lease past expiry, as the wall clock would. This is itself a write to
    // a live tokenized lease, so it declares the token first -- exactly as the
    // holder's own writes do; a raw update of a live lease is what the guard blocks.
    await dataSource.transaction(async (m) => {
      await m.query(
        `SELECT set_config('app.job_claim_lease_token', $1, true)`,
        [token],
      );
      await m.query(
        `UPDATE job_claims SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE user_id = $1`,
        [userId],
      );
    });

    // The trigger only guards a *live* lease, so an expired one is free to be
    // retaken (by either binary) and cleaned up -- otherwise a dead holder would
    // lock the work forever.
    await expect(oldRelease()).resolves.toBeDefined();
    expect(await claim()).toHaveLength(0);
  });

  it("leaves a permanent claimOnce row releasable without a token", async () => {
    // claimOnce rows carry no lease_token, so the trigger ignores them and the
    // ordinary release path still works.
    await withUserContext(userId, () =>
      service.claimOnce(JobClaimType.DemoIntraday, userId, KEY),
    );
    await withUserContext(userId, () =>
      service.releasePermanentClaim(JobClaimType.DemoIntraday, userId, KEY),
    );
    expect(await claim()).toHaveLength(0);
  });
});
