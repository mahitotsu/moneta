export type CustomerTab = "accounts" | "transfers";

/**
 * 顧客向け画面内の「口座」/「送金」タブ切り替え(docs/adr/0012決定6)。App.tsxの
 * 顧客ログイン/外部チャネル切替(`.mode-switch`、`active`/`secondary`のボタン流儀)を
 * bank-frame内のタブとしてそのまま再利用する。
 */
export function CustomerTabBar({ active, onSelect }: { active: CustomerTab; onSelect: (tab: CustomerTab) => void }) {
  return (
    <nav className="bank-tabs">
      <button
        type="button"
        className={active === "accounts" ? "active" : "secondary"}
        onClick={() => onSelect("accounts")}
      >
        口座
      </button>
      <button
        type="button"
        className={active === "transfers" ? "active" : "secondary"}
        onClick={() => onSelect("transfers")}
      >
        送金
      </button>
    </nav>
  );
}
