import { useState, type ReactNode } from "react";
import { getCurrentSession } from "../auth";
import { setBalanceHidden } from "../hooks/useBalanceVisibility";
import { SignInForm } from "./SignInForm";
import { AccountListScreen } from "./AccountListScreen";
import { CustomerAccountDetail } from "./CustomerAccountDetail";
import { TransferListScreen } from "./TransferListScreen";
import { TransferDetailScreen } from "./TransferDetailScreen";
import type { CustomerTab } from "./CustomerTabBar";

// `returnTo`は口座詳細⇔送金詳細の相互リンク(docs/adr/0021)専用——通常の一覧タブ経由の
// 遷移では付けない(その場合は`onBack`が既定のタブへ戻る)。ジャンプ元の画面を1段だけ
// 覚えておくための最小限の仕組みで、汎用のナビゲーションスタックは持たない
// (docs/adr/0007がルーターを避けている方針と同じ単純さの優先)。
type View =
  | { screen: "accounts" }
  | { screen: "account-detail"; accountId: string; returnTo?: View }
  | { screen: "transfers" }
  | { screen: "transfer-detail"; transferId: string; returnTo?: View };

const tabView = (tab: CustomerTab): View => (tab === "accounts" ? { screen: "accounts" } : { screen: "transfers" });

/** サインイン → (口座一覧|送金一覧)タブ → 各詳細、という顧客向けの画面遷移
 * (docs/adr/0009、docs/adr/0012決定6、docs/adr/0016)。実際の銀行アプリらしい見た目にするため、
 * 全画面を`.bank-frame`(カード状のアプリ外枠)で包む(docs/adr/0009へ追記の
 * 「顧客向けWeb UIの実物寄せ」)。 */
export function CustomerFlow() {
  const [session, setSession] = useState(() => getCurrentSession());
  const [view, setView] = useState<View>({ screen: "accounts" });

  const onSignedOut = () => {
    setSession(null);
    setView({ screen: "accounts" });
    // 共有端末を想定し、次にサインインする利用者へ前の利用者の残高マスクの選択を
    // 持ち越さない(useBalanceHiddenのコメント参照)。
    setBalanceHidden(true);
  };

  let content: ReactNode;
  if (!session) {
    content = (
      <SignInForm
        onSignedIn={(newSession) => {
          setSession(newSession);
          setView({ screen: "accounts" });
        }}
      />
    );
  } else if (view.screen === "account-detail") {
    const currentView = view;
    content = (
      <CustomerAccountDetail
        accountId={currentView.accountId}
        onBack={() => setView(currentView.returnTo ?? { screen: "accounts" })}
        onViewTransfer={(transferId) => setView({ screen: "transfer-detail", transferId, returnTo: currentView })}
      />
    );
  } else if (view.screen === "transfers") {
    content = (
      <TransferListScreen
        customerName={session.username}
        onSelectTransfer={(transferId) => setView({ screen: "transfer-detail", transferId })}
        onSelectTab={(tab) => setView(tabView(tab))}
        onSignedOut={onSignedOut}
      />
    );
  } else if (view.screen === "transfer-detail") {
    const currentView = view;
    content = (
      <TransferDetailScreen
        transferId={currentView.transferId}
        onBack={() => setView(currentView.returnTo ?? { screen: "transfers" })}
        onRecalled={(newTransferId) =>
          setView({ screen: "transfer-detail", transferId: newTransferId, returnTo: currentView.returnTo })
        }
        onViewAccount={(accountId) => setView({ screen: "account-detail", accountId, returnTo: currentView })}
      />
    );
  } else {
    content = (
      <AccountListScreen
        customerName={session.username}
        onSelectAccount={(accountId) => setView({ screen: "account-detail", accountId })}
        onSelectTab={(tab) => setView(tabView(tab))}
        onSignedOut={onSignedOut}
      />
    );
  }

  return <div className="bank-frame">{content}</div>;
}
