import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { BrandAppBar } from "./AppBar";
import { CustomerTabBar, type CustomerTab } from "./CustomerTabBar";
import { TransferForm, type StartedTransfer } from "./TransferForm";
import { PlusCircle } from "./icons";
import { getMyAccounts, getTransferStatus } from "../api/client";
import { addTransferFor, getTransfersFor, type CustomerTransfer } from "../transferHistory";
import { signOut } from "../auth";
import { formatAccountNumber, formatCurrency } from "../format";
import { TRANSFER_KIND_LABEL, TRANSFER_STATE_LABEL, type TransferState } from "../api/types";

// useAccountと同じ間隔(docs/adr/0012決定6、口座一覧のbalanceQueriesと同じ考え方)。
const POLL_INTERVAL_MS = 3000;

const STATE_BADGE_CLASS: Record<TransferState, string> = {
  pending_confirmation: "badge badge-pending",
  pending_debit: "badge badge-pending",
  pending_credit: "badge badge-pending",
  compensating: "badge badge-pending",
  credited: "badge badge-positive",
  compensated: "badge badge-neutral",
  failed: "badge badge-neutral",
  cancelled: "badge badge-neutral",
};

interface Props {
  customerName: string;
  onSelectTransfer: (transferId: string) => void;
  onSelectTab: (tab: CustomerTab) => void;
  onSignedOut: () => void;
}

/** 顧客が開始した送金の一覧(localStorageのみ、docs/adr/0012決定6)+ 振替/振込の新規依頼。
 * AccountListScreenと対になる、「送金」タブの中身。 */
export function TransferListScreen({ customerName, onSelectTransfer, onSelectTab, onSignedOut }: Props) {
  const [transfers, setTransfers] = useState<CustomerTransfer[]>(() => getTransfersFor(customerName));
  // "other-bank"は非機能なプレースホルダ(docs/adr/0015決定7)——選んでもTransferFormは出さず、
  // 案内文だけを表示する。バックエンド呼び出しは一切発生しない。
  const [openForm, setOpenForm] = useState<"furikae" | "furikomi" | "other-bank" | null>(null);

  // どの口座が自分のものかはサーバー側のCustomerAccountsTable(docs/adr/0016決定4)から取る
  // (AccountListScreenと同じ理由)。
  const myAccountsQuery = useQuery({
    queryKey: ["my-accounts"],
    queryFn: () => getMyAccounts(),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const accounts = myAccountsQuery.data ?? [];

  // 一覧の各行のバッジを最新化するため、表示中の送金を並行ポーリングする
  // (AccountListScreenのbalanceQueriesと同じ理由・同じqueryKeyでTransferDetailScreenと
  // キャッシュを共有する)。
  const statusQueries = useQueries({
    queries: transfers.map((t) => ({
      queryKey: ["transfer", t.transferId],
      queryFn: () => getTransferStatus(t.transferId),
      refetchInterval: POLL_INTERVAL_MS,
    })),
  });

  const recordStarted = (kind: "furikae" | "furikomi", started: StartedTransfer) => {
    addTransferFor(customerName, { ...started, kind, startedAt: new Date().toISOString() });
    setTransfers(getTransfersFor(customerName));
    setOpenForm(null);
    onSelectTransfer(started.transferId);
  };

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
        <CustomerTabBar active="transfers" onSelect={onSelectTab} />

        {transfers.length === 0 ? (
          <div className="panel">
            <p>まだ送金の依頼はありません。下から振替・振込を行ってください。</p>
          </div>
        ) : (
          <ul className="account-list">
            {transfers.map((t, i) => {
              const state = statusQueries[i]?.data?.state;
              return (
                <li key={t.transferId}>
                  <button type="button" className="account-card" onClick={() => onSelectTransfer(t.transferId)}>
                    <span className="account-card-main">
                      <span className="account-card-name">{TRANSFER_KIND_LABEL[t.kind]}</span>
                      <span className="account-card-number">
                        ●●●●{formatAccountNumber(t.toAccountId).slice(-4)} 宛
                      </span>
                    </span>
                    <span className="account-card-side">
                      <span className="account-card-balance">{formatCurrency(t.amount)}</span>
                      {state ? (
                        <span className={STATE_BADGE_CLASS[state]}>{TRANSFER_STATE_LABEL[state]}</span>
                      ) : (
                        <span className="badge badge-pending">反映待ち</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {myAccountsQuery.isLoading ? (
          <div className="panel">
            <div className="skeleton skeleton-line" style={{ width: "60%" }} />
          </div>
        ) : accounts.length === 0 ? (
          <div className="panel">
            <p>送金を行うには、まず口座を開設してください。</p>
          </div>
        ) : (
          <>
            <div className="operations-grid">
              <button
                type="button"
                className="add-account-tile"
                onClick={() => setOpenForm(openForm === "furikae" ? null : "furikae")}
                disabled={accounts.length < 2}
              >
                <PlusCircle />
                振替
              </button>
              <button
                type="button"
                className="add-account-tile"
                onClick={() => setOpenForm(openForm === "furikomi" ? null : "furikomi")}
              >
                <PlusCircle />
                振込
              </button>
              <button
                type="button"
                className="add-account-tile"
                onClick={() => setOpenForm(openForm === "other-bank" ? null : "other-bank")}
              >
                <PlusCircle />
                振込(他行あて)
              </button>
            </div>
            {accounts.length < 2 && <p className="subtitle">振替を行うには2つ以上の口座が必要です。</p>}

            {(openForm === "furikae" || openForm === "furikomi") && (
              <TransferForm
                kind={openForm}
                accounts={accounts}
                onStarted={(started) => recordStarted(openForm, started)}
              />
            )}

            {openForm === "other-bank" && (
              <div className="panel">
                <p>他行あての振込は現在サポートしておりません。今後の検証テーマです。</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
