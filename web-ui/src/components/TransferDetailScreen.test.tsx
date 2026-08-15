// docs/e2e-scenarios.md FC11/FC12 (旧J5/J9/J10)と、docs/adr/0012決定6のトレードオフ(反映待ちの404と
// 「まだ存在しないID」が区別できない/組戻し時間窓の最終判定は常にサーバー側)をweb-ui単体で
// 検証する。実際のHTTP越しの状態遷移はapi-e2e/scenarios/transfer-*.e2e.test.tsが検証するため、
// ここではAccountView.test.tsxと同じ理由(UI表示ロジックはWeb UI側のコードにしかない)で
// コンポーネント単体テストに絞る。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransferDetailScreen } from "./TransferDetailScreen";
import type { TransferStatusView } from "../api/types";

vi.mock("../api/client", () => ({
  getAccountNumber: vi.fn(),
  getTransferStatus: vi.fn(),
  confirmTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  recallTransfer: vi.fn(),
}));

const { getAccountNumber, getTransferStatus } = await import("../api/client");
const getAccountNumberMock = vi.mocked(getAccountNumber);
const getTransferStatusMock = vi.mocked(getTransferStatus);
// 送金元・送金先の口座番号表示(docs/adr/0019)。個々のテストは口座番号の表示自体を
// 主張しないため、AccountView.test.tsxと同じく未反映(null)のまま固定しておく。
getAccountNumberMock.mockResolvedValue(null);

// このファイルは1テストにつき1回renderするため、testing-libraryの自動cleanupが無い設定
// (AccountView.test.tsxと同じ)でも前のテストのDOMが残らないよう明示的に片付ける——このファイル
// は「取消す」のようにテスト間で衝突しうるテキストを問い合わせるため、蓄積したDOMがあると
// 誤って複数要素にマッチしてしまう。
afterEach(cleanup);

function renderDetail(transferId: string) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferDetailScreen transferId={transferId} onBack={() => {}} onRecalled={() => {}} />
    </QueryClientProvider>,
  );
}

function view(overrides: Partial<TransferStatusView>): TransferStatusView {
  return {
    transferId: "t-1",
    fromAccountId: "11111111-1111-1111-1111-111111111111",
    toAccountId: "22222222-2222-2222-2222-222222222222",
    amount: "1000",
    kind: "furikomi",
    state: "credited",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("反映待ちはエラーとして表示されない", () => {
  it("取得が一時的に失敗している間、エラー文言ではなく穏やかな待ち文言になる", async () => {
    getTransferStatusMock.mockRejectedValue(new Error("情報の取得に失敗しました。時間をおいて再度お試しください。"));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText(/まだ最新の情報に反映されていません/)).toBeTruthy();
    });
    expect(screen.queryByText(/エラー/)).toBeNull();
    expect(screen.queryByText(/失敗/)).toBeNull();
  });
});

describe("J5: 振込の確認待ちでは確認/取消ボタンを出す", () => {
  it("pending_confirmationの間は確認/取消ボタンが表示される", async () => {
    getTransferStatusMock.mockResolvedValue(view({ state: "pending_confirmation" }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText("振込を確定する")).toBeTruthy();
    });
    expect(screen.getByText("取消す")).toBeTruthy();
  });
});

describe("J9/J10: 組戻しボタンは credited かつ時間窓内の振込にのみ出す(表示上のヒント)", () => {
  it("creditedかつ24時間以内の振込には組戻しボタンが表示される", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    getTransferStatusMock.mockResolvedValue(view({ state: "credited", kind: "furikomi", updatedAt: recent }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText("組戻す")).toBeTruthy();
    });
  });

  it("24時間の時間窓を過ぎた振込には組戻しボタンを表示しない(最終判定はサーバー側)", async () => {
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    getTransferStatusMock.mockResolvedValue(view({ state: "credited", kind: "furikomi", updatedAt: expired }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText("送金が完了しました。")).toBeTruthy();
    });
    expect(screen.queryByText("組戻す")).toBeNull();
  });

  it("振替(furikae)は完了していても組戻しボタンを表示しない", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    getTransferStatusMock.mockResolvedValue(view({ state: "credited", kind: "furikae", updatedAt: recent }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText("送金が完了しました。")).toBeTruthy();
    });
    expect(screen.queryByText("組戻す")).toBeNull();
  });
});
