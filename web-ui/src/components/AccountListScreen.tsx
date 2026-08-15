import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { OpenAccountForm } from "./OpenAccountForm";
import { BrandAppBar } from "./AppBar";
import { CustomerTabBar, type CustomerTab } from "./CustomerTabBar";
import { Eye, EyeOff, PlusCircle } from "./icons";
import { getAccount, getAccountNumber, getMyAccounts } from "../api/client";
import { MASKED_BALANCE, formatCurrency, formatFriendlyAccountNumber } from "../format";
import { signOut } from "../auth";
import { useBalanceHidden } from "../hooks/useBalanceVisibility";

const STATUS_LABEL: Record<string, string> = { active: "有効", frozen: "凍結中", closed: "解約済み" };
const STATUS_BADGE_CLASS: Record<string, string> = {
  active: "badge badge-positive",
  frozen: "badge badge-pending",
  closed: "badge badge-neutral",
};

// customer-accounts-projectorの反映を見せつつも待たせすぎないポーリング間隔
// (docs/adr/0016決定4、既存のbalanceQueries/numberQueriesと同じ考え方)。
const POLL_INTERVAL_MS = 5000;

interface Props {
  customerName: string;
  onSelectAccount: (accountId: string) => void;
  onSelectTab: (tab: CustomerTab) => void;
  onSignedOut: () => void;
}

export function AccountListScreen({ customerName, onSelectAccount, onSelectTab, onSignedOut }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();
  // 口座詳細(AccountView)と共有する残高マスクの状態。以前は詳細画面にしか目アイコンが
  // 無く、この一覧では合計残高・各口座カードの残高が常時平文表示だった(改善前の問題)。
  const [balanceHidden, toggleBalanceHidden] = useBalanceHidden();

  // 「どの口座を自分が持っているか」はもうlocalStorageではなく、サーバー側の
  // CustomerAccountsTable(docs/adr/0016決定4)——ownerIdはCognito JWTのsubから
  // サーバー側が決めるため、他人の口座が紛れ込む余地がない。
  const myAccountsQuery = useQuery({
    queryKey: ["my-accounts"],
    queryFn: () => getMyAccounts(),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const accounts = myAccountsQuery.data ?? [];

  // ダッシュボードの各口座カードに残高を出すため、一覧表示中は全口座を並行ポーリングする
  // (AccountViewと同じqueryKeyを使うので、詳細画面へ入った時点でキャッシュが温まっている)。
  const balanceQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ["account", a.accountId],
      queryFn: () => getAccount(a.accountId),
      refetchInterval: POLL_INTERVAL_MS,
    })),
  });

  // 一覧の各カードにも自分の口座番号(docs/adr/0015)を出す。balanceQueriesと同じ理由
  // (AccountViewとqueryKeyを共有し、詳細画面へ入った時点でキャッシュが温まっている)。
  const numberQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ["account-number", a.accountId],
      queryFn: () => getAccountNumber(a.accountId),
      refetchInterval: POLL_INTERVAL_MS,
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
        <CustomerTabBar active="accounts" onSelect={onSelectTab} />

        {accounts.length > 0 && (
          <div className="panel total-balance-panel">
            <p className="subtitle">合計残高(解約済みの口座を除く)</p>
            <div className="balance-row total-balance-row">
              <p className="balance-figure">
                {balanceHidden ? MASKED_BALANCE : formatCurrency(totalBalance.toFixed(2))}
              </p>
              <button
                type="button"
                className="icon-button"
                onClick={toggleBalanceHidden}
                aria-label={balanceHidden ? "残高を表示" : "残高を隠す"}
              >
                {balanceHidden ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </div>
        )}

        {myAccountsQuery.isLoading ? (
          <div className="panel">
            <div className="skeleton skeleton-line" style={{ width: "60%" }} />
          </div>
        ) : accounts.length === 0 ? (
          <div className="panel">
            <p>まだ口座がありません。下から口座を開設してください。</p>
          </div>
        ) : (
          <ul className="account-list">
            {accounts.map((a, i) => {
              const account = balanceQueries[i]?.data;
              const accountNumber = numberQueries[i]?.data;
              const accountNumberLabel = accountNumber
                ? `${accountNumber.branchName} ${formatFriendlyAccountNumber(accountNumber.accountNumber)}`
                : "口座番号を確認しています…";

              return (
                <li key={a.accountId}>
                  <button type="button" className="account-card" onClick={() => onSelectAccount(a.accountId)}>
                    <span className="account-card-main">
                      <span className="account-card-name">普通預金</span>
                      <span className="account-card-number">{accountNumberLabel}</span>
                    </span>
                    <span className="account-card-side">
                      {account ? (
                        <>
                          <span className="account-card-balance">
                            {balanceHidden ? MASKED_BALANCE : formatCurrency(account.balance)}
                          </span>
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
          <OpenAccountForm
            onOpened={() => {
              setAddOpen(false);
              // customer-accounts-projectorの反映を待たず、まず取れる分だけ即座に再確認する
              // (反映まではPOLL_INTERVAL_MSごとの自動ポーリングが拾う)。
              void queryClient.invalidateQueries({ queryKey: ["my-accounts"] });
            }}
          />
        )}
      </div>
    </>
  );
}
