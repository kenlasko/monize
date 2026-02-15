import { SetMetadata } from "@nestjs/common";
import { SKIP_PASSWORD_CHECK_KEY } from "../guards/must-change-password.guard";

export const SkipPasswordCheck = () =>
  SetMetadata(SKIP_PASSWORD_CHECK_KEY, true);
