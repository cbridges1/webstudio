import { resetDatabase, waitForDatabase } from "./db";
import { dashboardUrl, test } from "./test";

test("prepare Builder E2E environment", async ({ page }) => {
  await waitForDatabase();
  await resetDatabase();
  await page.goto(`${dashboardUrl}/login`);
  await page
    .getByRole("button", { name: "Login with Secret" })
    .waitFor({ state: "visible", timeout: 60_000 });
});
