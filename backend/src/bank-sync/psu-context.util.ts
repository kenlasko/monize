import type { Request } from "express";
import { clientIpOf } from "../common/client-ip.util";
import {
  PSU_IP_MAX_LENGTH,
  PSU_USER_AGENT_MAX_LENGTH,
} from "./bank-sync.constants";
import type { PsuContext } from "./providers/bank-sync-provider.interface";

/** Sent when a browser did not identify itself; still a user-present read. */
const UNKNOWN_USER_AGENT = "Monize";

/**
 * Who is at the keyboard, for a user-present sync, so the bank does not count
 * the read against the unattended-access limit (docs/specs/bank-sync.md
 * section 7 step 3).
 *
 * The address is `clientIpOf`, the deployment's one reading of a request
 * (`trust proxy` is set in `main.ts`); an address that cannot be determined is
 * unknown, and a sync without one is sent as unattended rather than with an
 * invented address. Both values are bounded before they leave for the bank.
 */
export function psuContextOf(
  req: Request,
  userAgent: string | undefined,
): PsuContext | null {
  const ipAddress = clientIpOf(req);
  if (ipAddress === null) return null;
  const agent = userAgent?.trim();
  return {
    ipAddress: ipAddress.slice(0, PSU_IP_MAX_LENGTH),
    userAgent: agent
      ? agent.slice(0, PSU_USER_AGENT_MAX_LENGTH)
      : UNKNOWN_USER_AGENT,
  };
}
