import { expect, type Page } from "@playwright/test";

/**
 * Finish onboarding for a newly bootstrapped E2E user. Legacy-exempt users can
 * briefly visit the profile URL while their profile loads, so wait for either
 * the rendered onboarding form or the home screen it lands on.
 */
export async function completeOnboardingIfRequired(page: Page): Promise<void> {
    await page.waitForURL(/\/(inicio|onboarding\/profile)/, {
        timeout: 15_000,
    });
    if (new URL(page.url()).pathname === "/onboarding/profile") {
        const continueButton = page.getByRole("button", { name: "Continue" });
        const homeSummary = page.getByRole("region", { name: "Resumo" });
        await expect(continueButton.or(homeSummary)).toBeVisible({
            timeout: 15_000,
        });
        if (await continueButton.isVisible()) {
            await continueButton.click();
            await page.waitForURL(/\/onboarding\/practice/, {
                timeout: 15_000,
            });
            await page.getByRole("button", { name: "Skip" }).click();
            await page.waitForURL(/\/onboarding\/invitations/, {
                timeout: 15_000,
            });
            await page.getByRole("button", { name: "Finish" }).click();
        }
    }
    await page.waitForURL(/\/inicio/, { timeout: 15_000 });
}
