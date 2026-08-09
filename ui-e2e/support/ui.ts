// Thin wrappers over web-ui's actual rendered text/labels (web-ui/src/components/
// TransferListScreen.tsx, TransferForm.tsx, TransferDetailScreen.tsx). No test-id attributes
// exist in web-ui yet, so these select by the same accessible name a real customer would read --
// which also means a copy change there breaks these specs, which is the point: these specs are
// meant to catch exactly that kind of wiring drift (docs/adr/0014).
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export async function goToTransfersTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "送金", exact: true }).click();
}

export async function startFurikae(
  page: Page,
  params: { fromAccountId: string; toAccountId: string; amount: string },
): Promise<void> {
  await page.getByRole("button", { name: "振替", exact: true }).click();
  await page.getByLabel("送金元の口座").selectOption({ value: params.fromAccountId });
  await page.getByLabel("送金先の口座", { exact: true }).selectOption({ value: params.toAccountId });
  await page.getByLabel("金額").fill(params.amount);
  await page.getByRole("button", { name: "振替を実行する" }).click();
}

export async function startFurikomi(
  page: Page,
  params: { fromAccountId: string; toAccountId: string; amount: string },
): Promise<void> {
  await page.getByRole("button", { name: "振込", exact: true }).click();
  await page.getByLabel("送金元の口座").selectOption({ value: params.fromAccountId });
  await page.getByLabel("送金先の口座ID").fill(params.toAccountId);
  await page.getByLabel("金額").fill(params.amount);
  await page.getByRole("button", { name: "振込を依頼する" }).click();
}

export async function clickConfirmTransfer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "振込を確定する" }).click();
}

// TransferDetailScreen.tsx gates these two behind window.confirm(); Playwright dismisses native
// dialogs by default, which would silently no-op the click, so the handler must be armed first.
export async function clickCancelTransfer(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消す" }).click();
}

export async function clickRecall(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "組戻す" }).click();
}

/** TransferDetailScreen.tsx's state badge (TRANSFER_STATE_LABEL, docs/adr/0012決定6). Default
 * timeout is generous: a furikae/furikomi happy path crosses two saga hops (debit, then
 * credit), each behind its own DynamoDB Streams -> projector Lambda -> TransferStatusView
 * projection hop, on top of the useTransfer poll interval. */
export async function expectStateBadge(page: Page, label: string, timeoutMs = 90_000): Promise<void> {
  await expect(page.locator(".balance-hero-top .badge")).toHaveText(label, { timeout: timeoutMs });
}

export async function expectKindLabel(page: Page, label: string, timeoutMs = 90_000): Promise<void> {
  await expect(page.locator(".balance-hero-top .account-type")).toHaveText(label, { timeout: timeoutMs });
}
