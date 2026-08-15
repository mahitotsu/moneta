// Covers docs/e2e-scenarios.md E7 (旧F3) --反映待ち(結果整合性のラグ)と一時的な取得失敗は、顧客
// から見れば区別がつかない「まだ表示できていない」でしかなく、どちらも「エラー」と言い切らず
// 同じ穏やかな文言で表示し、既に取得済みの残高があればそれを表示し続ける(AccountView.tsx
// のコメント参照)。この主張はapi-e2eのHTTPベースのハーネスでは検証できない(実際の画面の
// 表示ロジックはWeb UI側のコードにしかない)ため、コンポーネント単体で検証する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { AccountView } from "./AccountView";
import { setBalanceHidden } from "../hooks/useBalanceVisibility";
import { MASKED_BALANCE } from "../format";
import type { AccountNumberLookup, AccountView as AccountViewData } from "../api/types";

vi.mock("../api/client", () => ({
  getAccount: vi.fn(),
  getAccountNumber: vi.fn(),
}));

const { getAccount, getAccountNumber } = await import("../api/client");
const getAccountMock = vi.mocked(getAccount);
const getAccountNumberMock = vi.mocked(getAccountNumber);
// 既存のF3系テストは口座番号表示自体を主張しないため、未反映(null)のまま固定しておく
// (個々のテストが必要に応じて上書きする)。
getAccountNumberMock.mockResolvedValue(null);

// 残高マスクのテストは同じテキスト("¥ ••••••••"等)を複数テストで主張するため、前の
// テストのDOMが残ったままだと多重ヒットになる。既存のF3系テストはこれまでcleanupなしでも
// アカウントIDや文言が毎回違って偶然衝突しなかっただけなので、ここで明示的に揃える。
afterEach(cleanup);

// 残高マスクは口座一覧と共有するモジュール単位の状態(既定は非表示)なので、マスク自体を
// 主張しない既存のテストが金額の文字列を直接読めるよう、各テストの前に「表示」へ揃える。
beforeEach(() => {
  setBalanceHidden(false);
});

function renderAccountView(accountId: string) {
  // retryDelay: 0 -- 本番のリトライ回数(retry: 1)はそのまま、バックオフの実時間待ちだけを
  // テストのために省く。retry回数自体は上書きしていないので、isErrorに至るまでの経路は本番
  // と同じ。
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountView accountId={accountId} onRemoved={() => {}} />
    </QueryClientProvider>,
  );
  return queryClient;
}

function assertNoErrorWording() {
  expect(screen.queryByText(/エラー/)).toBeNull();
  expect(screen.queryByText(/失敗/)).toBeNull();
}

describe("F3: 反映待ちはエラーとして表示されない", () => {
  it("取得が一時的に失敗している間、エラー文言ではなく穏やかな待ち文言になる", async () => {
    getAccountMock.mockRejectedValue(new Error("情報の取得に失敗しました。時間をおいて再度お試しください。"));

    renderAccountView("11111111-1111-1111-1111-111111111111");

    await waitFor(() => {
      expect(screen.getByText(/まだ最新の情報に反映されていません/)).toBeTruthy();
    });
    assertNoErrorWording();
  });

  it("表示済みの残高がある状態で取得が失敗しても、直前の残高を表示し続ける", async () => {
    const activeView: AccountViewData = {
      status: "active",
      balance: "1000",
      frozenReason: null,
      frozenAt: null,
      closedAt: null,
    };
    getAccountMock.mockResolvedValueOnce(activeView);
    getAccountMock.mockRejectedValue(new Error("情報の取得に失敗しました。時間をおいて再度お試しください。"));

    const accountId = "22222222-2222-2222-2222-222222222222";
    const queryClient = renderAccountView(accountId);

    await waitFor(() => {
      expect(screen.getByText("¥1,000")).toBeTruthy();
    });

    // 実際のポーリング(refetchInterval)を実時間で待つ代わりに、その1回分をここで模す。
    await queryClient.refetchQueries({ queryKey: ["account", accountId] });

    expect(screen.getByText("¥1,000")).toBeTruthy();
    assertNoErrorWording();
  });
});

// docs/adr/0015: 自分の口座番号(支店+7桁)を、UUIDのマスク表示の代わりに実際に表示する。
describe("口座番号(docs/adr/0015)の表示", () => {
  const activeView: AccountViewData = {
    status: "active",
    balance: "1000",
    frozenReason: null,
    frozenAt: null,
    closedAt: null,
  };

  it("account-number-projectorの反映がまだ終わっていない間は、失敗ではなく穏やかな待ち文言になる", async () => {
    getAccountMock.mockResolvedValue(activeView);
    getAccountNumberMock.mockResolvedValue(null);

    renderAccountView("33333333-3333-3333-3333-333333333333");

    await waitFor(() => {
      expect(screen.getByText(/口座番号を確認しています/)).toBeTruthy();
    });
    assertNoErrorWording();
  });

  it("反映済みなら支店名・支店番号・口座番号を表示する", async () => {
    getAccountMock.mockResolvedValue(activeView);
    const lookup: AccountNumberLookup = {
      accountId: "44444444-4444-4444-4444-444444444444",
      ownerName: "taro",
      accountNumber: "1234567",
      branchCode: "001",
      branchName: "本店",
    };
    getAccountNumberMock.mockResolvedValue(lookup);

    renderAccountView(lookup.accountId);

    await waitFor(() => {
      expect(screen.getByText(/本店\(001\) 123-4567/)).toBeTruthy();
    });
  });
});

// 口座一覧(AccountListScreen)と共有するマスク状態(useBalanceHidden)を、この画面の
// 目アイコンからも切り替えられることを確認する。
describe("残高マスク", () => {
  const activeView: AccountViewData = {
    status: "active",
    balance: "1000",
    frozenReason: null,
    frozenAt: null,
    closedAt: null,
  };

  it("マスクされている間は実額の代わりに固定文字列を表示する", async () => {
    setBalanceHidden(true);
    getAccountMock.mockResolvedValue(activeView);

    renderAccountView("55555555-5555-5555-5555-555555555555");

    await waitFor(() => {
      expect(screen.getByText(MASKED_BALANCE)).toBeTruthy();
    });
    expect(screen.queryByText("¥1,000")).toBeNull();
  });

  it("目アイコンをクリックすると実額表示に切り替わる", async () => {
    setBalanceHidden(true);
    getAccountMock.mockResolvedValue(activeView);

    renderAccountView("66666666-6666-6666-6666-666666666666");

    await waitFor(() => {
      expect(screen.getByText(MASKED_BALANCE)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "残高を表示" }));

    await waitFor(() => {
      expect(screen.getByText("¥1,000")).toBeTruthy();
    });
    expect(screen.queryByText(MASKED_BALANCE)).toBeNull();
  });
});
