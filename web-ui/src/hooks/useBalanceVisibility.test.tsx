// 口座一覧(AccountListScreen)と口座詳細(AccountView)の両方が同じマスク状態を共有する
// ことと、その既定値(プライバシーバイデフォルト)を検証する。コンポーネント個別のテスト
// (AccountView.test.tsx / AccountListScreen.test.tsx)は「マスクされていれば●●表示、
// トグルすれば実額が出る」という表示側の配線だけを見るため、状態そのものの契約はここに
// 集約する。
import { afterEach, beforeEach, describe, expect, vi, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// モジュール単位で状態を持つ実装なので、「初回ロード時の既定値」を毎回まっさらな状態で
// 検証できるよう、テストごとにモジュールキャッシュとsessionStorageをリセットしてから
// 動的importする(トップレベルの静的importだとファイル内で使い回されてしまう)。
beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

afterEach(cleanup);

async function renderProbe() {
  const { useBalanceHidden } = await import("./useBalanceVisibility");
  function Probe() {
    const [hidden, toggle] = useBalanceHidden();
    return (
      <div>
        <span>{hidden ? "隠す" : "表示"}</span>
        <button onClick={toggle}>切替</button>
      </div>
    );
  }
  render(<Probe />);
}

describe("残高マスクの状態(useBalanceHidden)", () => {
  it("sessionStorageに保存が無い場合、既定で「隠す」になる", async () => {
    await renderProbe();
    expect(screen.getByText("隠す")).toBeTruthy();
  });

  it("トグルすると状態が切り替わり、sessionStorageにも保存される", async () => {
    await renderProbe();
    fireEvent.click(screen.getByText("切替"));
    expect(screen.getByText("表示")).toBeTruthy();
    expect(sessionStorage.getItem("moneta.balanceHidden")).toBe("false");
  });

  it("同一タブでの再読み込み後も、直前の選択をsessionStorageから引き継ぐ", async () => {
    const { setBalanceHidden } = await import("./useBalanceVisibility");
    setBalanceHidden(false);

    // 「タブのリロード」を、モジュールを読み直すことで模す。
    vi.resetModules();
    await renderProbe();

    expect(screen.getByText("表示")).toBeTruthy();
  });

  it("setBalanceHiddenで直接リセットできる(サインアウト時、共有端末での持ち越し防止用)", async () => {
    const { setBalanceHidden } = await import("./useBalanceVisibility");
    setBalanceHidden(false);
    await renderProbe();
    expect(screen.getByText("表示")).toBeTruthy();

    setBalanceHidden(true);
    await waitFor(() => {
      expect(screen.getByText("隠す")).toBeTruthy();
    });
  });
});
