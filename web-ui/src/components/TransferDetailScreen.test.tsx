// docs/e2e-scenarios.md FC11/FC12 (旧J5/J9/J10)と、docs/adr/0012決定6のトレードオフ(反映待ちの404と
// 「まだ存在しないID」が区別できない/組戻し時間窓の最終判定は常にサーバー側)をweb-ui単体で
// 検証する。実際のHTTP越しの状態遷移はapi-e2e/scenarios/transfer-*.e2e.test.tsが検証するため、
// ここではAccountView.test.tsxと同じ理由(UI表示ロジックはWeb UI側のコードにしかない)で
// コンポーネント単体テストに絞る。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransferDetailScreen } from "./TransferDetailScreen";
import { TRANSFER_KIND_LABEL, type AccountNumberLookup, type MyAccount, type TransferStatusView } from "../api/types";

vi.mock("../api/client", () => ({
  getAccountNumber: vi.fn(),
  getMyAccounts: vi.fn(),
  getTransferStatus: vi.fn(),
  confirmTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  recallTransfer: vi.fn(),
}));

const { getAccountNumber, getMyAccounts, getTransferStatus } = await import("../api/client");
const getAccountNumberMock = vi.mocked(getAccountNumber);
const getMyAccountsMock = vi.mocked(getMyAccounts);
const getTransferStatusMock = vi.mocked(getTransferStatus);
// 送金元・送金先の口座番号表示(docs/adr/0019)。個々のテストは口座番号の表示自体を
// 主張しないため、AccountView.test.tsxと同じく未反映(null)のまま固定しておく。
getAccountNumberMock.mockResolvedValue(null);
// 相手方の名義表示(docs/adr/0020)の判定に使う自分の口座一覧。個々のテストは名義表示自体を
// 主張しないため、既定では空のまま固定しておく。
getMyAccountsMock.mockResolvedValue([]);

// このファイルは1テストにつき1回renderするため、testing-libraryの自動cleanupが無い設定
// (AccountView.test.tsxと同じ)でも前のテストのDOMが残らないよう明示的に片付ける——このファイル
// は「取消す」のようにテスト間で衝突しうるテキストを問い合わせるため、蓄積したDOMがあると
// 誤って複数要素にマッチしてしまう。
afterEach(cleanup);

function renderDetail(transferId: string, onViewAccount: (accountId: string) => void = () => {}) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferDetailScreen
        transferId={transferId}
        onBack={() => {}}
        onSelectTab={() => {}}
        onRecalled={() => {}}
        onViewAccount={onViewAccount}
      />
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

// docs/adr/0025: transfer-status-projectorがcashFeeを投影するようになったのに、
// 送金詳細画面が一度もそれを表示していなかったギャップを埋める。
describe("docs/adr/0025: 現金負担分の手数料が実際にかかった振込にだけ表示する", () => {
  it("cashFeeが0でない場合、手数料の行を表示する", async () => {
    getTransferStatusMock.mockResolvedValue(view({ amount: "300", cashFee: "120" }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText("手数料")).toBeTruthy();
    });
    expect(screen.getByText("¥120")).toBeTruthy();
  });

  it("cashFeeが0の場合(振替・組戻し、または手数料原資確保前の振込)、手数料の行を出さない", async () => {
    getTransferStatusMock.mockResolvedValue(view({ kind: "furikae", cashFee: "0" }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText(TRANSFER_KIND_LABEL.furikae)).toBeTruthy();
    });
    expect(screen.queryByText("手数料")).toBeNull();
  });

  it("cashFeeが無い(GET /customers/me/transfers由来を模したデータの)場合も、手数料の行を出さない", async () => {
    const { cashFee: _cashFee, ...withoutCashFee } = view({});
    getTransferStatusMock.mockResolvedValue(withoutCashFee as TransferStatusView);

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText(TRANSFER_KIND_LABEL.furikomi)).toBeTruthy();
    });
    expect(screen.queryByText("手数料")).toBeNull();
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

// docs/adr/0020: 振込(furikomi)/組戻し(recall)は自分の口座でない側(相手方)にだけ
// 名義を添える——自分側は自明なので出さない。furikaeは両方とも自分名義なので出さない。
describe("送金元・送金先のうち相手方にだけ名義を添える(docs/adr/0020)", () => {
  function accountNumber(overrides: Partial<AccountNumberLookup>): AccountNumberLookup {
    return {
      accountId: "unused",
      ownerName: "unused",
      accountNumber: "1234567",
      branchCode: "001",
      branchName: "本店",
      ...overrides,
    };
  }

  it("自分が送金元の振込は、送金先(相手)にだけ名義を表示する", async () => {
    const mine: MyAccount = { accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" };
    getMyAccountsMock.mockResolvedValue([mine]);
    getTransferStatusMock.mockResolvedValue(
      view({ fromAccountId: mine.accountId, toAccountId: "22222222-2222-2222-2222-222222222222", kind: "furikomi" }),
    );
    getAccountNumberMock.mockImplementation(async (accountId: string) =>
      accountId === mine.accountId
        ? accountNumber({ accountId, ownerName: "taro" })
        : accountNumber({ accountId, ownerName: "hanako" }),
    );

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText(/hanako様/)).toBeTruthy();
    });
    expect(screen.queryByText(/taro様/)).toBeNull();
  });

  it("自分が送金先(受取側)の振込は、送金元(相手)にだけ名義を表示する", async () => {
    const mine: MyAccount = { accountId: "22222222-2222-2222-2222-222222222222", openedAt: "2026-08-01T00:00:00Z" };
    getMyAccountsMock.mockResolvedValue([mine]);
    getTransferStatusMock.mockResolvedValue(
      view({ fromAccountId: "11111111-1111-1111-1111-111111111111", toAccountId: mine.accountId, kind: "furikomi" }),
    );
    getAccountNumberMock.mockImplementation(async (accountId: string) =>
      accountId === mine.accountId
        ? accountNumber({ accountId, ownerName: "taro" })
        : accountNumber({ accountId, ownerName: "hanako" }),
    );

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getByText(/hanako様/)).toBeTruthy();
    });
    expect(screen.queryByText(/taro様/)).toBeNull();
  });

  it("振替(furikae)はどちらの側にも名義を表示しない", async () => {
    const mine: MyAccount = { accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" };
    getMyAccountsMock.mockResolvedValue([mine]);
    getTransferStatusMock.mockResolvedValue(
      view({ fromAccountId: mine.accountId, toAccountId: "22222222-2222-2222-2222-222222222222", kind: "furikae" }),
    );
    getAccountNumberMock.mockResolvedValue(accountNumber({ accountId: "any", ownerName: "taro" }));

    renderDetail("t-1");

    await waitFor(() => {
      // 送金元・送金先とも同じ口座番号を返すモックなので2件ヒットする(名義さえ付かなければどちらでもよい)。
      expect(screen.getAllByText("本店 123-4567")).toHaveLength(2);
    });
    expect(screen.queryByText(/様/)).toBeNull();
  });
});

// docs/adr/0021: 送金元・送金先のうち自分の口座である側にだけ、入出金履歴への相互リンクを出す。
describe("自分の口座である側にだけ入出金履歴へのリンクを出す(docs/adr/0021)", () => {
  it("自分が送金元の振込は、送金元の側だけにリンクが出て、押すとonViewAccountを呼ぶ", async () => {
    const mine: MyAccount = { accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" };
    getMyAccountsMock.mockResolvedValue([mine]);
    getTransferStatusMock.mockResolvedValue(
      view({ fromAccountId: mine.accountId, toAccountId: "22222222-2222-2222-2222-222222222222", kind: "furikomi" }),
    );
    const onViewAccount = vi.fn();

    renderDetail("t-1", onViewAccount);

    await waitFor(() => {
      expect(screen.getAllByText("入出金履歴を見る")).toHaveLength(1);
    });
    fireEvent.click(screen.getByText("入出金履歴を見る"));
    expect(onViewAccount).toHaveBeenCalledWith(mine.accountId);
  });

  it("振替(furikae)は送金元・送金先とも自分名義なので両方にリンクが出る", async () => {
    const fromId = "11111111-1111-1111-1111-111111111111";
    const toId = "22222222-2222-2222-2222-222222222222";
    getMyAccountsMock.mockResolvedValue([
      { accountId: fromId, openedAt: "2026-08-01T00:00:00Z" },
      { accountId: toId, openedAt: "2026-08-01T00:00:00Z" },
    ]);
    getTransferStatusMock.mockResolvedValue(view({ fromAccountId: fromId, toAccountId: toId, kind: "furikae" }));

    renderDetail("t-1");

    await waitFor(() => {
      expect(screen.getAllByText("入出金履歴を見る")).toHaveLength(2);
    });
  });
});
