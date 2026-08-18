// docs/adr/0016決定4: 口座一覧はもうlocalStorage(customerSession.ts)ではなく、
// Cognito認証済みユーザーのsubから引くサーバー側のCustomerAccountsTableが真実源になった
// ことを検証する。あわせて、今回の脆弱性の直接の原因だった「既存の口座をこの一覧に追加」
// (生の口座IDを手入力する)フォームがもう存在しないことを固定する回帰テスト。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { AccountListScreen } from "./AccountListScreen";
import { setBalanceHidden } from "../hooks/useBalanceVisibility";
import { MASKED_BALANCE } from "../format";
import type { AccountView, MyAccount } from "../api/types";

vi.mock("../api/client", () => ({
  getMyAccounts: vi.fn(),
  getAccount: vi.fn(),
  getAccountNumber: vi.fn(),
  getMyPoints: vi.fn(),
}));

const { getMyAccounts, getAccount, getAccountNumber, getMyPoints } = await import("../api/client");
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getAccountMock = vi.mocked(getAccount);
const getAccountNumberMock = vi.mocked(getAccountNumber);
const getMyPointsMock = vi.mocked(getMyPoints);

afterEach(cleanup);

// 残高マスクは口座詳細と共有するモジュール単位の状態(既定は非表示)。マスク自体を
// 主張しない既存のテストが金額の文字列を直接読めるよう、各テストの前に「表示」へ揃える
// (マスクそのものの挙動は下の別describeで検証する)。
beforeEach(() => {
  setBalanceHidden(false);
  // docs/adr/0025: BrandAppBarが常時呼ぶようになったフック。ポイント残高自体を主張しない
  // 既存のテストに影響しない既定値。
  getMyPointsMock.mockResolvedValue({ balance: "0" });
});

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

// 改善前は口座詳細(AccountView)にしか目アイコンが無く、この一覧では合計残高・各口座
// カードの残高が常時平文表示だった。一覧でも同じ共有状態(useBalanceHidden)でマスク
// されること、および一箇所のトグルで両方(合計・カード)が連動することを固定する。
describe("残高マスクは一覧全体(合計残高・口座カード)に適用される", () => {
  function stubOneAccount() {
    const accounts: MyAccount[] = [
      { accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" },
    ];
    getMyAccountsMock.mockResolvedValue(accounts);
    const view: AccountView = { status: "active", balance: "1000", frozenReason: null, frozenAt: null, closedAt: null };
    getAccountMock.mockResolvedValue(view);
    getAccountNumberMock.mockResolvedValue(null);
  }

  it("既定(非表示)では合計残高・口座カードの残高がどちらもマスクされる", async () => {
    setBalanceHidden(true);
    stubOneAccount();

    renderScreen();

    await waitFor(() => {
      // 合計残高パネル + 口座カード1件分、あわせて2箇所がマスク表示になる。
      expect(screen.getAllByText(MASKED_BALANCE).length).toBe(2);
    });
    expect(screen.queryByText("¥1,000")).toBeNull();
  });

  it("目アイコンをクリックすると合計残高・口座カードの残高が両方とも実額表示に変わる", async () => {
    setBalanceHidden(true);
    stubOneAccount();

    renderScreen();

    await waitFor(() => {
      expect(screen.getAllByText(MASKED_BALANCE).length).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "残高を表示" }));

    await waitFor(() => {
      expect(screen.getByText("¥1,000")).toBeTruthy(); // 口座カード
      expect(screen.getByText("¥1,000.00")).toBeTruthy(); // 合計残高(toFixed(2)経由)
    });
    expect(screen.queryByText(MASKED_BALANCE)).toBeNull();
  });
});
