import { useState } from "react";
import { AccountView } from "./components/AccountView";
import { OpenAccountForm } from "./components/OpenAccountForm";
import { AmountOperationForm } from "./components/AmountOperationForm";
import { FreezeForm } from "./components/FreezeForm";
import { SimpleActionButton } from "./components/SimpleActionButton";
import { deposit, withdraw, unfreeze, closeAccount } from "./api/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function App() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");

  return (
    <>
      <h1>moneta</h1>
      <p className="subtitle">
        口座操作コンソール(認証なし・単一オペレーター向け、docs/adr/0007)。書き込みは非同期
        (202 Accepted)のため、操作後に照会結果へ反映されるまで少し時間がかかります。
      </p>

      {accountId ? (
        <>
          <button type="button" className="secondary" onClick={() => setAccountId(null)}>
            ← 別の口座を開く
          </button>
          <AccountView accountId={accountId} />
          <div className="operations-grid">
            <AmountOperationForm accountId={accountId} title="入金" submitLabel="入金する" action={deposit} />
            <AmountOperationForm accountId={accountId} title="出金" submitLabel="出金する" action={withdraw} />
          </div>
          <FreezeForm accountId={accountId} />
          <div className="operations-grid">
            <SimpleActionButton
              accountId={accountId}
              title="凍結解除"
              submitLabel="凍結を解除する"
              action={unfreeze}
            />
            <SimpleActionButton
              accountId={accountId}
              title="解約"
              submitLabel="口座を解約する"
              confirmMessage="この口座を解約します。よろしいですか?"
              action={closeAccount}
            />
          </div>
        </>
      ) : (
        <>
          <OpenAccountForm onOpened={setAccountId} />
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (UUID_PATTERN.test(manualId)) setAccountId(manualId);
            }}
          >
            <h2>既存の口座を開く</h2>
            <div className="field-row">
              <input
                placeholder="口座ID (UUID)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <button type="submit" disabled={!UUID_PATTERN.test(manualId)}>
                開く
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}

export default App;
