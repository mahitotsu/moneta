// docs/adr/0016決定4: 口座一覧はもうlocalStorage(customerSession.ts)ではなく、
// Cognito認証済みユーザーのsubから引くサーバー側のCustomerAccountsTableが真実源になった
// ことを検証する。あわせて、今回の脆弱性の直接の原因だった「既存の口座をこの一覧に追加」
// (生の口座IDを手入力する)フォームがもう存在しないことを固定する回帰テスト。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { AccountListScreen } from "./AccountListScreen";
import type { AccountView, MyAccount } from "../api/types";

vi.mock("../api/client", () => ({
  getMyAccounts: vi.fn(),
  getAccount: vi.fn(),
  getAccountNumber: vi.fn(),
}));

const { getMyAccounts, getAccount, getAccountNumber } = await import("../api/client");
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getAccountMock = vi.mocked(getAccount);
const getAccountNumberMock = vi.mocked(getAccountNumber);

afterEach(cleanup);

function renderScreen() {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountListScreen
        customerName="taro-yamada"
        onSelectAccount={() => {}}
        onSelectTab={() => {}}
        onSignedOut={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("口座一覧はサーバー側のCustomerAccountsTableから取得する(docs/adr/0016決定4)", () => {
  it("GET /customers/me/accountsが返した口座を一覧表示する(ownerIdをクライアントが指定する余地はない)", async () => {
    const accounts: MyAccount[] = [{ accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" }];
    getMyAccountsMock.mockResolvedValue(accounts);
    const view: AccountView = { status: "active", balance: "1000", frozenReason: null, frozenAt: null, closedAt: null };
    getAccountMock.mockResolvedValue(view);
    getAccountNumberMock.mockResolvedValue(null);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("¥1,000")).toBeTruthy();
    });
    expect(getMyAccountsMock).toHaveBeenCalled();
  });

  it("1件も無ければ「まだ口座がありません」を表示する(手入力での追加を促さない)", async () => {
    getMyAccountsMock.mockResolvedValue([]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("まだ口座がありません。下から口座を開設してください。")).toBeTruthy();
    });
  });
});

describe("「既存の口座をこの一覧に追加」フォームは廃止済み(docs/adr/0016)", () => {
  it("口座IDを手入力する欄がどこにも無い", async () => {
    getMyAccountsMock.mockResolvedValue([]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("まだ口座がありません。下から口座を開設してください。")).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText("口座ID")).toBeNull();
    expect(screen.queryByText("既存の口座をこの一覧に追加")).toBeNull();
  });
});
