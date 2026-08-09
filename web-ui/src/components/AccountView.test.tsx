// Covers docs/e2e-scenarios.md F3 --反映待ち(結果整合性のラグ)と一時的な取得失敗は、顧客
// から見れば区別がつかない「まだ表示できていない」でしかなく、どちらも「エラー」と言い切らず
// 同じ穏やかな文言で表示し、既に取得済みの残高があればそれを表示し続ける(AccountView.tsx
// のコメント参照)。この主張はapi-e2eのHTTPベースのハーネスでは検証できない(実際の画面の
// 表示ロジックはWeb UI側のコードにしかない)ため、コンポーネント単体で検証する。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { AccountView } from "./AccountView";
import type { AccountView as AccountViewData } from "../api/types";

vi.mock("../api/client", () => ({
  getAccount: vi.fn(),
}));

const { getAccount } = await import("../api/client");
const getAccountMock = vi.mocked(getAccount);

function renderAccountView(accountId: string) {
  // retryDelay: 0 -- 本番のリトライ回数(retry: 1)はそのまま、バックオフの実時間待ちだけを
  // テストのために省く。retry回数自体は上書きしていないので、isErrorに至るまでの経路は本番
  // と同じ。
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountView accountId={accountId} customerName="taro" onRemoved={() => {}} />
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
