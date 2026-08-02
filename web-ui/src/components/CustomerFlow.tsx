import { useState } from "react";
import { getSignedInCustomer, signIn } from "../customerSession";
import { SignInForm } from "./SignInForm";
import { AccountListScreen } from "./AccountListScreen";
import { CustomerAccountDetail } from "./CustomerAccountDetail";

/** サインイン → 口座一覧 → 口座詳細、という顧客向けの画面遷移(docs/adr/0009)。 */
export function CustomerFlow() {
  const [customerName, setCustomerName] = useState<string | null>(() => getSignedInCustomer());
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  if (!customerName) {
    return (
      <SignInForm
        onSignedIn={(name) => {
          signIn(name);
          setCustomerName(name);
        }}
      />
    );
  }

  if (selectedAccountId) {
    return <CustomerAccountDetail accountId={selectedAccountId} onBack={() => setSelectedAccountId(null)} />;
  }

  return (
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
