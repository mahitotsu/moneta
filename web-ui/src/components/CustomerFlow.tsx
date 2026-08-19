import { useState, type ReactNode } from "react";
import { getCurrentSession } from "../auth";
import { setBalanceHidden } from "../hooks/useBalanceVisibility";
import { SignInForm } from "./SignInForm";
import { AccountListScreen } from "./AccountListScreen";
import { CustomerAccountDetail } from "./CustomerAccountDetail";
import { TransferListScreen } from "./TransferListScreen";
import { TransferDetailScreen } from "./TransferDetailScreen";
import { PointsHistoryScreen } from "./PointsHistoryScreen";
import type { CustomerTab } from "./CustomerTabBar";

// 口座タブ・送金タブはそれぞれ独立した画面状態(一覧/詳細)を持つ(docs/adr/0022)。タブを
// 切り替えても互いの状態はそのまま保持される——「戻る」は常に今のタブを一覧へ1段戻すだけの
// 一定の意味を持ち、タブをまたぐ移動(相互リンクを含む、docs/adr/0021)は常にタブバー
// (CustomerTabBar、詳細画面にも常設)の役目にする。以前は単一のView共用体+`returnTo`
// (直前の画面を1段だけ覚える仕組み)で表現していたが、「戻る」の意味が経路によって変わり、
// 相互リンクを辿った直後に混乱を招いた——タブごとに状態を分離することで、`returnTo`という
// 特別な仕組み無しに「元のタブに戻れば元の場所のまま」が自然に成り立つ。
type AccountsTabView = { screen: "list" } | { screen: "detail"; accountId: string };
type TransfersTabView = { screen: "list" } | { screen: "detail"; transferId: string };

const ACCOUNTS_LIST: AccountsTabView = { screen: "list" };
const TRANSFERS_LIST: TransfersTabView = { screen: "list" };

/** サインイン → (口座|送金)タブ、各タブは一覧⇔詳細を独立に持つ、という顧客向けの画面遷移
 * (docs/adr/0009、docs/adr/0012決定6、docs/adr/0016、docs/adr/0021・0022)。実際の銀行アプリ
 * らしい見た目にするため、全画面を`.bank-frame`(カード状のアプリ外枠)で包む
 * (docs/adr/0009へ追記の「顧客向けWeb UIの実物寄せ」)。 */
export function CustomerFlow() {
  const [session, setSession] = useState(() => getCurrentSession());
  const [activeTab, setActiveTab] = useState<CustomerTab>("accounts");
  const [accountsTabView, setAccountsTabView] = useState<AccountsTabView>(ACCOUNTS_LIST);
  const [transfersTabView, setTransfersTabView] = useState<TransfersTabView>(TRANSFERS_LIST);
  // ポイント履歴(docs/adr/0026)は「口座」「送金」どちらのタブとも独立した、ヘッダーバッジ
  // から開く画面(3つ目の常設タブにはしない設計判断)。どちらのタブのview状態も一切触らない
  // ため、閉じれば開いた時点の画面へそのまま戻る——accountsTabView/transfersTabViewと同じ
  // 「タブの状態は勝手に変えない」というADR-0022の考え方をここにも適用している。
  const [pointsHistoryOpen, setPointsHistoryOpen] = useState(false);

  const resetNavigation = () => {
    setActiveTab("accounts");
    setAccountsTabView(ACCOUNTS_LIST);
    setTransfersTabView(TRANSFERS_LIST);
    setPointsHistoryOpen(false);
  };

  const onSignedOut = () => {
    setSession(null);
    resetNavigation();
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
          resetNavigation();
        }}
      />
    );
  } else if (pointsHistoryOpen) {
    content = (
      <PointsHistoryScreen
        onBack={() => setPointsHistoryOpen(false)}
        activeTab={activeTab}
        onSelectTab={(tab) => {
          setPointsHistoryOpen(false);
          setActiveTab(tab);
        }}
        onViewTransfer={(transferId) => {
          setPointsHistoryOpen(false);
          setTransfersTabView({ screen: "detail", transferId });
          setActiveTab("transfers");
        }}
      />
    );
  } else if (activeTab === "accounts") {
    content =
      accountsTabView.screen === "detail" ? (
        <CustomerAccountDetail
          accountId={accountsTabView.accountId}
          onBack={() => setAccountsTabView(ACCOUNTS_LIST)}
          onSelectTab={setActiveTab}
          onViewTransfer={(transferId) => {
            setTransfersTabView({ screen: "detail", transferId });
            setActiveTab("transfers");
          }}
        />
      ) : (
        <AccountListScreen
          customerName={session.username}
          onSelectAccount={(accountId) => setAccountsTabView({ screen: "detail", accountId })}
          onSelectTab={setActiveTab}
          onSignedOut={onSignedOut}
          onViewPointsHistory={() => setPointsHistoryOpen(true)}
        />
      );
  } else {
    content =
      transfersTabView.screen === "detail" ? (
        <TransferDetailScreen
          transferId={transfersTabView.transferId}
          onBack={() => setTransfersTabView(TRANSFERS_LIST)}
          onSelectTab={setActiveTab}
          onRecalled={(newTransferId) => setTransfersTabView({ screen: "detail", transferId: newTransferId })}
          onViewAccount={(accountId) => {
            setAccountsTabView({ screen: "detail", accountId });
            setActiveTab("accounts");
          }}
        />
      ) : (
        <TransferListScreen
          customerName={session.username}
          onSelectTransfer={(transferId) => setTransfersTabView({ screen: "detail", transferId })}
          onSelectTab={setActiveTab}
          onSignedOut={onSignedOut}
          onViewPointsHistory={() => setPointsHistoryOpen(true)}
        />
      );
  }

  return <div className="bank-frame">{content}</div>;
}
