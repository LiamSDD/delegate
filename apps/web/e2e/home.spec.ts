import { expect, test } from "@playwright/test";

test("home page renders the hero and detects a mission", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Give it a goal.");
  await page.getByLabel("Company URL, GitHub repo or goal").fill("github.com/vercel/next.js");
  await expect(page.getByText("Repo X-ray", { exact: true }).first()).toBeVisible();
});
