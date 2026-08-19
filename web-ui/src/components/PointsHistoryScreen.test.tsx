// docs/adr/0026: ポイント履歴画面。reserved(充当、減る)/awarded(付与、増える)/refunded
// (返却、増える)の3種類を正しくラベル・符号付きで表示し、各行から原因の送金の詳細へ
// 相互リンクできることを検証する(ADR-0021と同じ考え方)。このコンポーネントの最初のテスト
// ファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { PointsHistoryScreen } from "./PointsHistoryScreen";
import type { PointsHistoryEntry } from "../api/types";

vi.mock("../api/client", () => ({
  getMyPoints: vi.fn(),
  getMyPointsHistory: vi.fn(),
}));

const { getMyPoints, getMyPointsHistory } = await import("../api/client");
const getMyPointsMock = vi.mocked(getMyPoints);
const getMyPointsHistoryMock = vi.mocked(getMyPointsHistory);

afterEach(cleanup);

function entry(overrides: Partial<PointsHistoryEntry> = {}): PointsHistoryEntry {
  return {
    type: "awarded",
    amount: "3",
    balanceAfter: "23",
    occurredAt: "2026-08-19T00:00:00Z",
    eventId: "11111111-1111-1111-1111-111111111111",
    transferId: "transfer-1",
    ...overrides,
  };
}

function renderScreen(onViewTransfer: (transferId: string) => void = () => {}) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <PointsHistoryScreen onBack={() => {}} activeTab="accounts" onSelectTab={() => {}} onViewTransfer={onViewTransfer} />
    </QueryClientProvider>,
  );
}

describe("現在の保有ポイントを見出しに表示する", () => {
  it("残高取得後、pt付きで表示する", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "123" });
    getMyPointsHistoryMock.mockResolvedValue([]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("123pt")).toBeTruthy();
    });
  });
});

describe("種類ごとに正しいラベル・符号で表示する(docs/adr/0026)", () => {
  it("awardedは「振込受取で付与」・+付きで表示する", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "23" });
    getMyPointsHistoryMock.mockResolvedValue([entry({ type: "awarded", amount: "3" })]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("振込受取で付与")).toBeTruthy();
    });
    expect(screen.getByText("+3pt")).toBeTruthy();
  });

  it("reservedは「手数料へ充当」・−付きで表示する", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "0" });
    getMyPointsHistoryMock.mockResolvedValue([entry({ type: "reserved", amount: "100" })]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("手数料へ充当")).toBeTruthy();
    });
    expect(screen.getByText("−100pt")).toBeTruthy();
  });

  it("refundedは「送金失敗により返却」・+付きで表示する", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "220" });
    getMyPointsHistoryMock.mockResolvedValue([entry({ type: "refunded", amount: "220" })]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("送金失敗により返却")).toBeTruthy();
    });
    expect(screen.getByText("+220pt")).toBeTruthy();
  });
});

describe("各行から原因の送金の詳細へ相互リンクする(ADR-0021と同じ考え方)", () => {
  it("「送金の詳細を見る」を押すとonViewTransferがそのtransferIdで呼ばれる", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "23" });
    getMyPointsHistoryMock.mockResolvedValue([entry({ transferId: "transfer-42" })]);
    const onViewTransfer = vi.fn();

    renderScreen(onViewTransfer);

    await waitFor(() => {
      expect(screen.getByText("送金の詳細を見る")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("送金の詳細を見る"));
    expect(onViewTransfer).toHaveBeenCalledWith("transfer-42");
  });
});

describe("履歴が無い場合", () => {
  it("空状態の案内文を表示する", async () => {
    getMyPointsMock.mockResolvedValue({ balance: "0" });
    getMyPointsHistoryMock.mockResolvedValue([]);

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("まだポイントの獲得・利用がありません。")).toBeTruthy();
    });
  });
});
