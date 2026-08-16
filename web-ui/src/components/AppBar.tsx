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

/** `backLabel`は呼び出し元ごとに必須(docs/adr/0022)——タブごとに独立したナビゲーション状態
 * を持つようになり、「戻る」は常にそのタブの一覧へ戻る一定の意味になったため、画面ごとに
 * 正しい戻り先を明示する。以前は"口座一覧へ戻る"に固定されており、`TransferDetailScreen`
 * (実際には送金一覧へ戻る)でも同じ文言になっていた。 */
export function DetailAppBar({ title, onBack, backLabel }: { title: string; onBack: () => void; backLabel: string }) {
  return (
    <header className="appbar">
      <button type="button" className="appbar-action" onClick={onBack} aria-label={backLabel}>
        <ChevronLeft />
      </button>
      <span className="appbar-title">{title}</span>
      <span className="appbar-spacer" />
    </header>
  );
}
