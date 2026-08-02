import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { OpenAccountForm } from "./OpenAccountForm";
import { BrandAppBar } from "./AppBar";
import { PlusCircle } from "./icons";
import { getAccount } from "../api/client";
import { formatAccountNumber, formatCurrency } from "../format";
import { addAccountFor, getAccountsFor, removeAccountFor, signOut, type CustomerAccount } from "../customerSession";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_LABEL: Record<string, string> = { active: "有効", frozen: "凍結中", closed: "解約済み" };
const STATUS_BADGE_CLASS: Record<string, string> = {
  active: "badge badge-positive",
  frozen: "badge badge-pending",
  closed: "badge badge-neutral",
};

interface Props {
  customerName: string;
  onSelectAccount: (accountId: string) => void;
  onSignedOut: () => void;
}

export function AccountListScreen({ customerName, onSelectAccount, onSignedOut }: Props) {
  const [accounts, setAccounts] = useState<CustomerAccount[]>(() => getAccountsFor(customerName));
  const [addOpen, setAddOpen] = useState(false);
  const [manualId, setManualId] = useState("");

  const refresh = () => setAccounts(getAccountsFor(customerName));

  // ダッシュボードの各口座カードに残高を出すため、一覧表示中は全口座を並行ポーリングする
  // (AccountViewと同じqueryKeyを使うので、詳細画面へ入った時点でキャッシュが温まっている)。
  const balanceQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ["account", a.accountId],
      queryFn: () => getAccount(a.accountId),
      refetchInterval: 5000,
    })),
  });

  const totalBalance = balanceQueries.reduce((sum, q) => {
    if (!q.data || q.data.status === "closed") return sum;
    return sum + Number(q.data.balance);
  }, 0);

  return (
    <>
      <BrandAppBar
        customerName={customerName}
        onSignOut={() => {
          signOut();
          onSignedOut();
        }}
      />
      <div className="bank-body">
        {accounts.length > 0 && (
          <div className="panel total-balance-panel">
            <p className="subtitle">合計残高(解約済みの口座を除く)</p>
            <p className="balance-figure">{formatCurrency(totalBalance.toFixed(2))}</p>
          </div>
        )}

        {accounts.length === 0 ? (
          <div className="panel">
            <p>まだ口座がありません。下から口座を追加してください。</p>
          </div>
        ) : (
          <ul className="account-list">
            {accounts.map((a, i) => {
              const query = balanceQueries[i];
              const account = query?.data;
              // isSuccess && data===nullは確定404(バックエンドにこの口座が存在しない)。
              // まだ読み込み中/反映待ち(dataがundefinedのまま)とは区別する——放置しても
              // 解決しないので、一覧から削除する手段をここで用意する。
              const isMissing = query?.isSuccess && account === null;

              if (isMissing) {
                return (
                  <li key={a.accountId}>
                    <div className="account-card account-card-missing">
                      <span className="account-card-main">
                        <span className="account-card-name">{a.nickname ?? "普通預金"}</span>
                        <span className="account-card-number">
                          ●●●●{formatAccountNumber(a.accountId).slice(-4)}
                        </span>
                        <span className="account-card-note">この口座は見つかりませんでした</span>
                      </span>
                      <button
                        type="button"
                        className="account-card-remove"
                        onClick={() => {
                          removeAccountFor(customerName, a.accountId);
                          refresh();
                        }}
                      >
                        一覧から削除
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li key={a.accountId}>
                  <button type="button" className="account-card" onClick={() => onSelectAccount(a.accountId)}>
                    <span className="account-card-main">
                      <span className="account-card-name">{a.nickname ?? "普通預金"}</span>
                      <span className="account-card-number">
                        ●●●●{formatAccountNumber(a.accountId).slice(-4)}
                      </span>
                    </span>
                    <span className="account-card-side">
                      {account ? (
                        <>
                          <span className="account-card-balance">{formatCurrency(account.balance)}</span>
                          <span className={STATUS_BADGE_CLASS[account.status]}>{STATUS_LABEL[account.status]}</span>
                        </>
                      ) : (
                        <span className="skeleton skeleton-line" />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button type="button" className="add-account-tile" onClick={() => setAddOpen((o) => !o)}>
          <PlusCircle />
          口座を追加
        </button>

        {addOpen && (
          <>
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
                  placeholder="口座ID"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                />
                <button type="submit" disabled={!UUID_PATTERN.test(manualId)}>
                  追加
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </>
  );
}
