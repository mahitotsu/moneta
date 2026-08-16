// docs/adr/0022: 口座タブ・送金タブはそれぞれ独立した画面状態(一覧/詳細)を持ち、タブバーは
// 詳細画面にも常設される。タブを切り替えても互いの状態は保持され、「戻る」は常に今のタブの
// 一覧へ戻るだけの一定の意味を持つ——このコンポーネントの最初のテストファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { CustomerFlow } from "./CustomerFlow";
import type { AccountNumberLookup, AccountView, MyAccount, TransferStatusView } from "../api/types";

vi.mock("../auth", () => ({
  getCurrentSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../api/client", () => ({
  getMyAccounts: vi.fn(),
  getAccount: vi.fn(),
  getAccountNumber: vi.fn(),
  getTransactionHistory: vi.fn(),
  getMyTransfers: vi.fn(),
  getTransferStatus: vi.fn(),
  confirmTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  recallTransfer: vi.fn(),
}));

const { getCurrentSession } = await import("../auth");
const {
  getMyAccounts,
  getAccount,
  getAccountNumber,
  getTransactionHistory,
  getMyTransfers,
  getTransferStatus,
} = await import("../api/client");

const getCurrentSessionMock = vi.mocked(getCurrentSession);
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getAccountMock = vi.mocked(getAccount);
const getAccountNumberMock = vi.mocked(getAccountNumber);
const getTransactionHistoryMock = vi.mocked(getTransactionHistory);
const getMyTransfersMock = vi.mocked(getMyTransfers);
const getTransferStatusMock = vi.mocked(getTransferStatus);

afterEach(cleanup);

const ACCOUNT: MyAccount = { accountId: "acct-1", openedAt: "2026-08-01T00:00:00Z" };
const ACCOUNT_VIEW: AccountView = { status: "active", balance: "1000.00", frozenReason: null, frozenAt: null, closedAt: null };
const NUMBER_LOOKUP: AccountNumberLookup = {
  accountId: "acct-1",
  ownerName: "taro",
  accountNumber: "1234567",
  branchCode: "001",
  branchName: "本店",
};
const TRANSFER: TransferStatusView = {
  transferId: "xfer-1",
  fromAccountId: "acct-1",
  toAccountId: "acct-2",
  amount: "500.00",
  kind: "furikae",
  state: "credited",
  updatedAt: "2026-08-14T00:00:00Z",
};

function renderApp() {
  getCurrentSessionMock.mockReturnValue({ sub: "sub-1", username: "taro" });
  getMyAccountsMock.mockResolvedValue([ACCOUNT]);
  getAccountMock.mockResolvedValue(ACCOUNT_VIEW);
  getAccountNumberMock.mockResolvedValue(NUMBER_LOOKUP);
  getTransactionHistoryMock.mockResolvedValue([]);
  getMyTransfersMock.mockResolvedValue([TRANSFER]);
  getTransferStatusMock.mockResolvedValue(TRANSFER);

  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <CustomerFlow />
    </QueryClientProvider>,
  );
}

describe("タブごとに独立した画面状態を持つ(docs/adr/0022)", () => {
  it("詳細画面にもタブバーが常設され、タブを切り替えても元の詳細画面の状態が保持される", async () => {
    renderApp();

    // 口座一覧 → 口座詳細。
    const accountCard = await screen.findByText("本店 123-4567");
    fireEvent.click(accountCard);
    await waitFor(() => {
      expect(screen.getByText("口座詳細")).toBeTruthy();
    });

    // 詳細画面にもタブバーが出ている(docs/adr/0022の主張そのもの)。
    expect(screen.getByText("口座")).toBeTruthy();
    expect(screen.getByText("送金")).toBeTruthy();

    // タブバーで「送金」へ切り替え、送金一覧 → 送金詳細まで進む。
    fireEvent.click(screen.getByText("送金"));
    const transferCard = await screen.findByText("振替", { selector: ".account-card-name" });
    fireEvent.click(transferCard);
    await waitFor(() => {
      expect(screen.getByText("送金の詳細")).toBeTruthy();
    });

    // タブバーで「口座」へ戻ると、口座一覧ではなく直前に見ていた口座詳細がそのまま出る
    // (「戻る」を経由していないので状態は保持されたまま、docs/adr/0022)。
    fireEvent.click(screen.getByText("口座"));
    await waitFor(() => {
      expect(screen.getByText("口座詳細")).toBeTruthy();
    });

    // 「戻る」は常にこのタブの一覧へ戻るだけの一定の意味を持つ。
    fireEvent.click(screen.getByRole("button", { name: "口座一覧へ戻る" }));
    await waitFor(() => {
      expect(screen.getByText("本店 123-4567")).toBeTruthy();
    });
    expect(screen.queryByText("口座詳細")).toBeNull();
  });
});
