import { useState, type ReactNode } from "react";
import { getSignedInCustomer, signIn } from "../customerSession";
import { SignInForm } from "./SignInForm";
import { AccountListScreen } from "./AccountListScreen";
import { CustomerAccountDetail } from "./CustomerAccountDetail";

/** サインイン → 口座一覧 → 口座詳細、という顧客向けの画面遷移(docs/adr/0009)。
 * 実際の銀行アプリらしい見た目にするため、全画面を`.bank-frame`(カード状のアプリ外枠)で
 * 包む(docs/adr/0009へ追記の「顧客向けWeb UIの実物寄せ」)。 */
export function CustomerFlow() {
  const [customerName, setCustomerName] = useState<string | null>(() => getSignedInCustomer());
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  let content: ReactNode;
  if (!customerName) {
    content = (
      <SignInForm
        onSignedIn={(name) => {
          signIn(name);
          setCustomerName(name);
        }}
      />
    );
  } else if (selectedAccountId) {
    content = <CustomerAccountDetail accountId={selectedAccountId} onBack={() => setSelectedAccountId(null)} />;
  } else {
    content = (
      <AccountListScreen
        customerName={customerName}
        onSelectAccount={setSelectedAccountId}
        onSignedOut={() => {
          setCustomerName(null);
          setSelectedAccountId(null);
        }}
      />
    );
  }

  return <div className="bank-frame">{content}</div>;
}
