import { useState } from "react";
import { OpenAccountForm } from "./OpenAccountForm";
import { addAccountFor, getAccountsFor, signOut, type CustomerAccount } from "../customerSession";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Props {
  customerName: string;
  onSelectAccount: (accountId: string) => void;
  onSignedOut: () => void;
}

export function AccountListScreen({ customerName, onSelectAccount, onSignedOut }: Props) {
  const [accounts, setAccounts] = useState<CustomerAccount[]>(() => getAccountsFor(customerName));
  const [manualId, setManualId] = useState("");

  const refresh = () => setAccounts(getAccountsFor(customerName));

  return (
    <>
      <div className="header-row">
        <h1>{customerName} 様の口座一覧</h1>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            signOut();
            onSignedOut();
          }}
        >
          サインアウト
        </button>
      </div>

      <div className="panel">
        {accounts.length === 0 ? (
          <p>まだ口座がありません。下から開設するか、既存の口座IDを追加してください。</p>
        ) : (
          <ul className="account-list">
            {accounts.map((a) => (
              <li key={a.accountId}>
                <button type="button" className="secondary" onClick={() => onSelectAccount(a.accountId)}>
                  {a.nickname ?? a.accountId}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <OpenAccountForm
        onOpened={(accountId) => {
          addAccountFor(customerName, accountId);
          refresh();
        }}
      />

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (!UUID_PATTERN.test(manualId)) return;
          addAccountFor(customerName, manualId);
          setManualId("");
          refresh();
        }}
      >
        <h2>既存の口座をこの一覧に追加</h2>
        <div className="field-row">
          <input
            placeholder="口座ID (UUID)"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
          />
          <button type="submit" disabled={!UUID_PATTERN.test(manualId)}>
            追加
          </button>
        </div>
      </form>
    </>
  );
}
