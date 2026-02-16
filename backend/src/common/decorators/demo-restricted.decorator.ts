import { SetMetadata } from "@nestjs/common";
import { DEMO_RESTRICTED_KEY } from "../guards/demo-mode.guard";

export const DemoRestricted = () => SetMetadata(DEMO_RESTRICTED_KEY, true);
