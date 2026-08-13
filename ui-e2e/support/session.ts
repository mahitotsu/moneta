// Seeds a real, already-signed-in Cognito session (web-ui/src/auth.ts's localStorage tokens)
// directly, so specs don't have to click through the (now-real, docs/adr/0016) sign-in screen to
// reach a signed-in customer -- that ground is exactly what scenarios/auth.spec.ts exists to cover
// (mirroring how the old dummy customerSession.ts's seedCustomerSession worked before ADR-0016,
// and the same "seed the boring setup, drive the browser only for what's actually under test"
// reasoning support/seed.ts already uses for account opening). The customer's own account list is
// no longer client-editable state to seed (docs/adr/0016決定4 removed that feature) -- it's
// server-authoritative (CustomerAccountsTable), so accounts opened via support/seed.ts as this same
// identity show up automatically once the browser loads with these tokens in place. Must be
// registered via BrowserContext.addInitScript before the first page.goto(): addInitScript only
// affects documents created after it's added, and auth.ts reads localStorage on first render.
import type { BrowserContext } from "@playwright/test";
import type { TestIdentity } from "./auth";

export async function seedAuthSession(context: BrowserContext, identity: TestIdentity): Promise<void> {
  await context.addInitScript(
    ({ idToken, accessToken, refreshToken }) => {
      localStorage.setItem("moneta.auth.idToken", idToken);
      localStorage.setItem("moneta.auth.accessToken", accessToken);
      localStorage.setItem("moneta.auth.refreshToken", refreshToken);
    },
    { idToken: identity.idToken, accessToken: identity.accessToken, refreshToken: identity.refreshToken },
  );
}
