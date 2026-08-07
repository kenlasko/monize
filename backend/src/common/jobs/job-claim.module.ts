import { Global, Module } from "@nestjs/common";
import { JobClaimService } from "./job-claim.service";
import { UserMaintenanceService } from "./user-maintenance.service";

/**
 * Global so any cron can claim its work without every feature module
 * re-declaring the provider -- and so there is exactly one claim mechanism to
 * find when the next multi-replica job needs one.
 */
@Global()
@Module({
  providers: [JobClaimService, UserMaintenanceService],
  exports: [JobClaimService, UserMaintenanceService],
})
export class JobClaimModule {}
