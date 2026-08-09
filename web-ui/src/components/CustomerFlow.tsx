import { useState, type ReactNode } from "react";
import { getSignedInCustomer, signIn } from "../customerSession";
import { SignInForm } from "./SignInForm";
import { AccountListScreen } from "./AccountListScreen";
import { CustomerAccountDetail } from "./CustomerAccountDetail";
import { TransferListScreen } from "./TransferListScreen";
import { TransferDetailScreen } from "./TransferDetailScreen";
import type { CustomerTab } from "./CustomerTabBar";

type View =
  | { screen: "accounts" }
  | { screen: "account-detail"; accountId: string }
  | { screen: "transfers" }
  | { screen: "transfer-detail"; transferId: string };

const tabView = (tab: CustomerTab): View => (tab === "accounts" ? { screen: "accounts" } : { screen: "transfers" });

/** サインイン → (口座一覧|送金一覧)タブ → 各詳細、という顧客向けの画面遷移
 * (docs/adr/0009、docs/adr/0012決定6)。実際の銀行アプリらしい見た目にするため、全画面を
 * `.bank-frame`(カード状のアプリ外枠)で包む(docs/adr/0009へ追記の「顧客向けWeb UIの実物寄せ」)。 */
export function CustomerFlow() {
  const [customerName, setCustomerName] = useState<string | null>(() => getSignedInCustomer());
  const [view, setView] = useState<View>({ screen: "accounts" });

  const onSignedOut = () => {
    setCustomerName(null);
    setView({ screen: "accounts" });
  };

  let content: ReactNode;
  if (!customerName) {
    content = (
      <SignInForm
        onSignedIn={(name) => {
          signIn(name);
          setCustomerName(name);
          setView({ screen: "accounts" });
        }}
      />
    );
  } else if (view.screen === "account-detail") {
    content = (
      <CustomerAccountDetail
        accountId={view.accountId}
        customerName={customerName}
        onBack={() => setView({ screen: "accounts" })}
      />
    );
  } else if (view.screen === "transfers") {
    content = (
      <TransferListScreen
        customerName={customerName}
        onSelectTransfer={(transferId) => setView({ screen: "transfer-detail", transferId })}
        onSelectTab={(tab) => setView(tabView(tab))}
        onSignedOut={onSignedOut}
      />
    );
  } else if (view.screen === "transfer-detail") {
    content = (
      <TransferDetailScreen
        transferId={view.transferId}
        customerName={customerName}
        onBack={() => setView({ screen: "transfers" })}
        onRecalled={(newTransferId) => setView({ screen: "transfer-detail", transferId: newTransferId })}
      />
    );
  } else {
    content = (
      <AccountListScreen
        customerName={customerName}
        onSelectAccount={(accountId) => setView({ screen: "account-detail", accountId })}
        onSelectTab={(tab) => setView(tabView(tab))}
        onSignedOut={onSignedOut}
      />
    );
  }

  return <div className="bank-frame">{content}</div>;
}
