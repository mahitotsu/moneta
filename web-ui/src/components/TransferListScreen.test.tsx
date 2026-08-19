// docs/adr/0015決定7: 振込の導線に自行/他行の分岐を追加した。他行あては非機能な
// プレースホルダで、選んでもTransferForm(≒バックエンド呼び出し)は一切出ないことを検証する。
// このコンポーネントの最初のテストファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransferListScreen } from "./TransferListScreen";
import type { AccountNumberLookup, MyAccount, TransferStatusView } from "../api/types";

vi.mock("../api/client", () => ({
  getAccountNumber: vi.fn(),
  getMyAccounts: vi.fn(),
  getMyTransfers: vi.fn(),
  getMyPoints: vi.fn(),
  getMyPointsHistory: vi.fn(),
}));

const { getAccountNumber, getMyAccounts, getMyTransfers, getMyPoints } = await import("../api/client");
const getAccountNumberMock = vi.mocked(getAccountNumber);
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getMyTransfersMock = vi.mocked(getMyTransfers);
const getMyPointsMock = vi.mocked(getMyPoints);
getMyTransfersMock.mockResolvedValue([]);
// 各送金カードの宛先口座番号(docs/adr/0019)。個々のテストは口座番号の表示自体を
// 主張しないため、AccountView.test.tsxと同じく未反映(null)のまま固定しておく。
getAccountNumberMock.mockResolvedValue(null);
// docs/adr/0025: BrandAppBarが常時呼ぶようになったフック。ポイント残高自体を主張しない
// 既存のテストに影響しない既定値。
getMyPointsMock.mockResolvedValue({ balance: "0" });

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
        onViewPointsHistory={() => {}}
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

// docs/adr/0020: 振込(furikomi)は自分が送った側か受け取った側かで「相手方」の口座が
// 逆になる。以前は常にtoAccountId(宛先)だけを見せていたため、受け取った側から見ると
// 「自分の口座宛」という無意味な表示になっていた。
describe("振込は送受信の方向に応じて相手方の名義を表示する(docs/adr/0020)", () => {
  function lookup(overrides: Partial<AccountNumberLookup> = {}): AccountNumberLookup {
    return {
      accountId: "99999999-9999-9999-9999-999999999999",
      ownerName: "hanako",
      accountNumber: "1234567",
      branchCode: "001",
      branchName: "本店",
      ...overrides,
    };
  }

  it("自分が送った振込は、送金先(相手)の名義に「様へ」を付けて表示する", async () => {
    getMyAccountsMock.mockResolvedValue([ACCOUNTS[0]]);
    const otherAccountId = "99999999-9999-9999-9999-999999999999";
    const transfer: TransferStatusView = {
      transferId: "44444444-4444-4444-4444-444444444444",
      fromAccountId: ACCOUNTS[0].accountId, // 送金元 = 自分
      toAccountId: otherAccountId, // 送金先 = 相手
      amount: "3000",
      kind: "furikomi",
      state: "credited",
      updatedAt: "2026-08-14T00:00:00Z",
    };
    getMyTransfersMock.mockResolvedValue([transfer]);
    getAccountNumberMock.mockImplementation(async (accountId: string) =>
      accountId === otherAccountId ? lookup({ accountId: otherAccountId, ownerName: "hanako" }) : null,
    );

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/hanako様へ/)).toBeTruthy();
    });
    expect(getAccountNumberMock).toHaveBeenCalledWith(otherAccountId);
  });

  it("受け取った振込は、送金元(相手)の名義に「様より」を付けて表示する", async () => {
    getMyAccountsMock.mockResolvedValue([ACCOUNTS[0]]);
    const senderAccountId = "88888888-8888-8888-8888-888888888888";
    const transfer: TransferStatusView = {
      transferId: "55555555-5555-5555-5555-555555555555",
      fromAccountId: senderAccountId, // 送金元 = 相手
      toAccountId: ACCOUNTS[0].accountId, // 送金先 = 自分(受け取った)
      amount: "2000",
      kind: "furikomi",
      state: "credited",
      updatedAt: "2026-08-14T00:00:00Z",
    };
    getMyTransfersMock.mockResolvedValue([transfer]);
    getAccountNumberMock.mockImplementation(async (accountId: string) =>
      accountId === senderAccountId ? lookup({ accountId: senderAccountId, ownerName: "jiro" }) : null,
    );

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/jiro様より/)).toBeTruthy();
    });
    // 受け取った側なので、相手方=送金元(senderAccountId)の口座番号を引く——
    // 従来の「常にtoAccountId(=自分)を引く」実装のバグが再発していないことの直接的な検証。
    expect(getAccountNumberMock).toHaveBeenCalledWith(senderAccountId);
  });
});
