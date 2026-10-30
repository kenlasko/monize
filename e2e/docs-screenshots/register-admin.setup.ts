import { test, expect } from "@playwright/test";
import { DOCS_ADMIN } from "./capture";

// `npm run docs:admin`: registers DOCS_ADMIN on a fresh instance. The first
// account registered becomes the instance admin, so this runs before the demo
// seed (website/README.md, "Screenshots"). Registering it a second time is
// refused, which is fine: it already exists.
test("register the documentation admin", async ({ request }) => {
  const res = await request.post("/api/v1/auth/register", { data: DOCS_ADMIN });
  expect([201, 400, 409]).toContain(res.status());
});
