// docs/adr/0015: 振込(furikomi)の宛先入力が、生UUID直接入力から「支店選択→口座番号入力→
// 検索→名義・支店確認→送信」に変わったことをコンポーネント単体で検証する(この画面固有の
// 表示・入力ロジックはWeb UI側のコードにしかない、AccountView.test.tsxと同じ理由)。
// このコンポーネントの最初のテストファイル。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { TransferForm } from "./TransferForm";
import type { AccountNumberLookup, MyAccount } from "../api/types";

vi.mock("../api/client", () => ({
  lookupAccountByNumber: vi.fn(),
  startTransfer: vi.fn(),
}));

const { lookupAccountByNumber, startTransfer } = await import("../api/client");
const lookupAccountByNumberMock = vi.mocked(lookupAccountByNumber);
const startTransferMock = vi.mocked(startTransfer);

const accounts: MyAccount[] = [{ accountId: "11111111-1111-1111-1111-111111111111", openedAt: "2026-08-01T00:00:00Z" }];

// このファイルは複数のテストで同じ文言(「確認する」等)を問い合わせるため、蓄積したDOMが
// 誤って複数要素にマッチしないよう明示的に片付ける(TransferDetailScreen.test.tsxと同じ理由)。
afterEach(cleanup);

function renderFurikomiForm() {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferForm kind="furikomi" accounts={accounts} onStarted={() => {}} />
    </QueryClientProvider>,
  );
}

function lookup(overrides: Partial<AccountNumberLookup> = {}): AccountNumberLookup {
  return {
    accountId: "22222222-2222-2222-2222-222222222222",
    ownerId: "hanako",
    accountNumber: "1234567",
    branchCode: "001",
    branchName: "本店",
    ...overrides,
  };
}

describe("振込(他の名義の口座へ)の宛先入力(docs/adr/0015)", () => {
  it("口座番号を検索して解決すると、名義・支店を表示し送信を有効化する", async () => {
    lookupAccountByNumberMock.mockResolvedValue(lookup());

    renderFurikomiForm();

    fireEvent.change(screen.getByLabelText("送金先の口座番号"), { target: { value: "1234567" } });
    fireEvent.click(screen.getByText("確認する"));

    await waitFor(() => {
      expect(screen.getByText(/宛先名義: hanako/)).toBeTruthy();
    });
    expect(lookupAccountByNumberMock).toHaveBeenCalledWith("1234567");

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "1000" } });
    const submit = screen.getByText("振込を依頼する") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => {
      expect(startTransferMock).toHaveBeenCalledWith(
        expect.any(String),
        accounts[0].accountId,
        "22222222-2222-2222-2222-222222222222",
        "1000",
      );
    });
  });

  it("見つからない口座番号は、誤入力とも反映待ちとも決めつけない穏やかな文言を表示し送信を無効のままにする", async () => {
    lookupAccountByNumberMock.mockResolvedValue(null);

    renderFurikomiForm();

    fireEvent.change(screen.getByLabelText("送金先の口座番号"), { target: { value: "9999999" } });
    fireEvent.click(screen.getByText("確認する"));

    await waitFor(() => {
      expect(screen.getByText(/この口座番号の口座が見つかりませんでした/)).toBeTruthy();
    });
    expect((screen.getByText("振込を依頼する") as HTMLButtonElement).disabled).toBe(true);
  });

  it("解決した口座の支店と選択した支店が一致しない場合、送信をブロックする", async () => {
    lookupAccountByNumberMock.mockResolvedValue(lookup({ branchCode: "001", branchName: "本店" }));

    renderFurikomiForm();

    // 既定の選択(本店/001)から、解決される口座とは違う支店へ切り替える。
    fireEvent.change(screen.getByLabelText("送金先の支店"), { target: { value: "002" } });
    fireEvent.change(screen.getByLabelText("送金先の口座番号"), { target: { value: "1234567" } });
    fireEvent.click(screen.getByText("確認する"));

    await waitFor(() => {
      expect(screen.getByText("支店が一致しません。支店・口座番号をご確認ください。")).toBeTruthy();
    });
    expect((screen.getByText("振込を依頼する") as HTMLButtonElement).disabled).toBe(true);
  });
});
