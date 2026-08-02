import { Bank, ChevronLeft, LogOut } from "./icons";

/** サインイン後の全画面で共通の「銀行アプリらしい」ヘッダー(docs/adr/0009の顧客体験再現)。 */
export function BrandAppBar({ customerName, onSignOut }: { customerName: string; onSignOut: () => void }) {
  return (
    <header className="appbar">
      <div className="appbar-brand">
        <span className="appbar-mark">
          <Bank />
        </span>
        <div className="appbar-titles">
          <span className="appbar-bank-name">モネタ銀行</span>
          <span className="appbar-greeting">{customerName} 様</span>
        </div>
      </div>
      <button type="button" className="appbar-action" onClick={onSignOut} aria-label="サインアウト">
        <LogOut />
      </button>
    </header>
  );
}

export function DetailAppBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="appbar">
      <button type="button" className="appbar-action" onClick={onBack} aria-label="口座一覧へ戻る">
        <ChevronLeft />
      </button>
      <span className="appbar-title">{title}</span>
      <span className="appbar-spacer" />
    </header>
  );
}
