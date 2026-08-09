// Seeds the localStorage-only "signed in customer" + "customer's own account list" state
// (web-ui/src/customerSession.ts) directly, so specs don't have to click through the
// (intentionally non-functional, docs/adr/0009決定2) sign-in screen or the "add account to this
// list" flow to reach a signed-in customer with known accounts -- that ground isn't part of the
// gap ui-e2e/ exists to cover (docs/adr/0014), and api-e2e/vitest already exercise it. Must be
// registered via BrowserContext.addInitScript before the first page.goto(): addInitScript only
// affects documents created after it's added, and customerSession.ts reads localStorage on
// first render.
import type { BrowserContext } from "@playwright/test";

export interface SeedAccount {
  accountId: string;
  nickname?: string;
}

export async function seedCustomerSession(
  context: BrowserContext,
  customerName: string,
  accounts: SeedAccount[],
): Promise<void> {
  await context.addInitScript(
    ({ customerName, accountsJson }) => {
      localStorage.setItem("moneta.signedInCustomer", customerName);
      localStorage.setItem(`moneta.accounts.${customerName}`, accountsJson);
    },
    { customerName, accountsJson: JSON.stringify(accounts) },
  );
}
