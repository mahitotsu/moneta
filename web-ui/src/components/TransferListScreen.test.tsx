// docs/adr/0015決定7: 振込の導線に自行/他行の分岐を追加した。他行あては非機能な
// プレースホルダで、選んでもTransferForm(≒バックエンド呼び出し)は一切出ないことを検証する。
// このコンポーネントの最初のテストファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransferListScreen } from "./TransferListScreen";
import type { MyAccount, TransferStatusView } from "../api/types";

vi.mock("../api/client", () => ({
  getMyAccounts: vi.fn(),
  getMyTransfers: vi.fn(),
}));

const { getMyAccounts, getMyTransfers } = await import("../api/client");
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getMyTransfersMock = vi.mocked(getMyTransfers);
getMyTransfersMock.mockResolvedValue([]);

const ACCOUNTS: MyAccount[] = [
  { accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" },
  { accountId: "22222222-2222-2222-2222-222222222222", openedAt: "2026-08-01T00:00:00Z" },
];

function renderScreen() {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferListScreen
        customerName="taro"
        onSelectTransfer={() => {}}
        onSelectTab={() => {}}
        onSignedOut={() => {}}
      />
    </QueryClientProvider>,
  );
}

// このファイルはタイル選択→表示内容の変化を追うため、蓄積したDOMが誤って複数要素に
// マッチしないよう明示的に片付ける(TransferDetailScreen.test.tsxと同じ理由)。
afterEach(cleanup);

describe("振込(他行あて)は非機能なプレースホルダ(docs/adr/0015決定7)", () => {
  it("選択すると案内文のみを表示し、振込フォーム(TransferForm)は出さない", async () => {
    getMyAccountsMock.mockResolvedValue(ACCOUNTS);
    renderScreen();

    fireEvent.click(await screen.findByText("振込(他行あて)"));

    expect(screen.getByText("他行あての振込は現在サポートしておりません。今後の検証テーマです。")).toBeTruthy();
    expect(screen.queryByText("振込を依頼する")).toBeNull();
    expect(screen.queryByLabelText("送金先の口座番号")).toBeNull();
  });

  it("振替/振込タイルと排他的に切り替わる(同時に2つのフォーム/案内は出ない)", async () => {
    getMyAccountsMock.mockResolvedValue(ACCOUNTS);
    renderScreen();

    fireEvent.click(await screen.findByText("振込"));
    expect(screen.getByLabelText("送金先の支店")).toBeTruthy();

    fireEvent.click(screen.getByText("振込(他行あて)"));
    expect(screen.queryByLabelText("送金先の支店")).toBeNull();
    expect(screen.getByText("他行あての振込は現在サポートしておりません。今後の検証テーマです。")).toBeTruthy();
  });
});

describe("送金一覧はサーバー側のCustomerTransfersTableから取得する(docs/adr/0017)", () => {
  it("GET /customers/me/transfersが返した送金を一覧表示する", async () => {
    getMyAccountsMock.mockResolvedValue(ACCOUNTS);
    const transfer: TransferStatusView = {
      transferId: "33333333-3333-3333-3333-333333333333",
      fromAccountId: ACCOUNTS[0].accountId,
      toAccountId: ACCOUNTS[1].accountId,
      amount: "5000",
      kind: "furikae",
      state: "credited",
      updatedAt: "2026-08-14T00:00:00Z",
    };
    getMyTransfersMock.mockResolvedValue([transfer]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("¥5,000")).toBeTruthy();
    });
    // "振替"タイルボタンとも表記が重なるため、一覧カード側の要素に絞って問い合わせる。
    expect(screen.getByText("振替", { selector: ".account-card-name" })).toBeTruthy();
    expect(screen.getByText("完了")).toBeTruthy();
    expect(getMyTransfersMock).toHaveBeenCalled();
  });

  it("1件も無ければ「まだ送金の依頼はありません」を表示する", async () => {
    getMyAccountsMock.mockResolvedValue(ACCOUNTS);
    getMyTransfersMock.mockResolvedValue([]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("まだ送金の依頼はありません。下から振替・振込を行ってください。")).toBeTruthy();
    });
  });
});
