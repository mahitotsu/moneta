// docs/adr/0021: 取引履歴の各行のうち、送金(transfer-service経由のDeposit/Withdraw)由来の
// ものだけに、その送金の詳細への相互リンクを出す。ATM入出金等の外部チャネル(docs/adr/0009決定1)
// や入出金を伴わない行(開設/凍結等)にはリンクを出さない。このコンポーネントの最初のテスト
// ファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransactionHistory } from "./TransactionHistory";
import type { TransactionEntry } from "../api/types";

vi.mock("../api/client", () => ({
  getTransactionHistory: vi.fn(),
}));

const { getTransactionHistory } = await import("../api/client");
const getTransactionHistoryMock = vi.mocked(getTransactionHistory);

afterEach(cleanup);

function entry(overrides: Partial<TransactionEntry> = {}): TransactionEntry {
  return {
    type: "deposited",
    amount: "5000.00",
    balanceAfter: "10000.00",
    occurredAt: "2026-08-16T00:00:00Z",
    eventId: "11111111-1111-1111-1111-111111111111",
    reason: null,
    transferId: null,
    channel: null,
    ...overrides,
  };
}

function renderHistory(onViewTransfer: (transferId: string) => void = () => {}) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionHistory accountId="account-1" onViewTransfer={onViewTransfer} />
    </QueryClientProvider>,
  );
}

describe("送金由来の行にだけ、送金の詳細へのリンクを出す(docs/adr/0021)", () => {
  it("transferIdを持つ行には「送金の詳細を見る」リンクが出て、押すとonViewTransferを呼ぶ", async () => {
    getTransactionHistoryMock.mockResolvedValue([entry({ transferId: "transfer-1" })]);
    const onViewTransfer = vi.fn();

    renderHistory(onViewTransfer);

    await waitFor(() => {
      expect(screen.getByText("送金の詳細を見る")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("送金の詳細を見る"));
    expect(onViewTransfer).toHaveBeenCalledWith("transfer-1");
  });

  it("transferIdが無い行(ATM入出金等)にはリンクを出さない", async () => {
    getTransactionHistoryMock.mockResolvedValue([entry({ transferId: null })]);

    renderHistory();

    await waitFor(() => {
      expect(screen.getByText("入金")).toBeTruthy();
    });
    expect(screen.queryByText("送金の詳細を見る")).toBeNull();
  });
});

describe("channelを持つ行には発生源のラベルを出す(docs/adr/0023)", () => {
  it("ATM入金にはATMラベルが出る", async () => {
    getTransactionHistoryMock.mockResolvedValue([entry({ transferId: null, channel: "Atm" })]);

    renderHistory();

    await waitFor(() => {
      expect(screen.getByText("ATM")).toBeTruthy();
    });
  });

  it("channelもtransferIdも無い行にはどちらのラベルも出ない", async () => {
    getTransactionHistoryMock.mockResolvedValue([entry({ transferId: null, channel: null })]);

    renderHistory();

    await waitFor(() => {
      expect(screen.getByText("入金")).toBeTruthy();
    });
    expect(screen.queryByText("ATM")).toBeNull();
    expect(screen.queryByText("送金の詳細を見る")).toBeNull();
  });
});
