import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrandAppBar } from "./AppBar";
import { CustomerTabBar, type CustomerTab } from "./CustomerTabBar";
import { TransferForm } from "./TransferForm";
import { ArrowDownLeft, ArrowUpRight, Bank, PlusCircle } from "./icons";
import { getAccountNumber, getMyAccounts, getMyTransfers } from "../api/client";
import { signOut } from "../auth";
import { formatCurrency, formatFriendlyAccountNumber } from "../format";
import { TRANSFER_KIND_LABEL, TRANSFER_STATE_LABEL, type TransferState, type TransferStatusView } from "../api/types";
import { usePointsBalance } from "../hooks/usePointsBalance";

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
  /** ヘッダーのポイントバッジをタップした時の遷移先(docs/adr/0026)。 */
  onViewPointsHistory: () => void;
}

/** 顧客が関わった送金の一覧(サーバー側`CustomerTransfersTable`、docs/adr/0017)+
 * 振替/振込の新規依頼。AccountListScreenと対になる、「送金」タブの中身。 */
export function TransferListScreen({ customerName, onSelectTransfer, onSelectTab, onSignedOut, onViewPointsHistory }: Props) {
  const queryClient = useQueryClient();
  // "other-bank"は非機能なプレースホルダ(docs/adr/0015決定7)——選んでもTransferFormは出さず、
  // 案内文だけを表示する。バックエンド呼び出しは一切発生しない。
  const [openForm, setOpenForm] = useState<"furikae" | "furikomi" | "other-bank" | null>(null);
  const { data: pointsBalance } = usePointsBalance();

  // どの口座が自分のものかはサーバー側のCustomerAccountsTable(docs/adr/0016決定4)から取る
  // (AccountListScreenと同じ理由)。
  const myAccountsQuery = useQuery({
    queryKey: ["my-accounts"],
    queryFn: () => getMyAccounts(),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const accounts = myAccountsQuery.data ?? [];

  // 送金一覧そのものもサーバー側の投影(docs/adr/0017)——AccountListScreenのmyAccountsQueryと
  // 同じ形。各カードの状態バッジもこのレスポンス自身が持つ`state`をそのまま使えるため、
  // 以前のように行ごとに`getTransferStatus`を並行ポーリングする必要はない。
  const myTransfersQuery = useQuery({
    queryKey: ["my-transfers"],
    queryFn: () => getMyTransfers(),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const transfers = myTransfersQuery.data ?? [];

  // 振込/組戻し(furikomi/recall、名義が自分と異なりうる)は、自分が送った側か受け取った側かで
  // 「相手方」の口座が逆になる——ADR-0017により振込は受取側の「送金」タブにも現れるが、従来は
  // 常にtoAccountId(宛先)だけを見せていたため、受け取った側から見ると「自分の口座宛」という
  // 無意味な表示になり、肝心の送金元(誰から受け取ったか)がどこにも出ていなかった(docs/adr/0020)。
  // 振替(furikae)は送金元・送金先とも常に自分名義なので「相手方」という概念自体が無い。
  const myAccountIds = new Set(accounts.map((a) => a.accountId));
  const myAccountsReady = myAccountsQuery.data !== undefined;

  function isOutgoing(t: TransferStatusView): boolean {
    return myAccountIds.has(t.fromAccountId);
  }
  function counterpartyAccountId(t: TransferStatusView): string {
    if (t.kind === "furikae" || !myAccountsReady) return t.toAccountId;
    return isOutgoing(t) ? t.toAccountId : t.fromAccountId;
  }

  // 各行の相手方口座を、AccountListScreen/AccountView.tsxと同じ「支店名 番号」の実際の口座番号
  // (docs/adr/0015)で表示する。以前はaccountIdのUUID末尾を口座番号風に見せかけていただけの
  // 表示専用の飾りを使っており、アプリの他画面と体裁が一致していなかった(docs/adr/0019)。
  // AccountNumberQueryApiは所有者を問わず任意のaccountIdを解決できるため、相手方が自分以外の
  // 口座(振込)でも同じ形で引ける——名義(ownerName、docs/adr/0018)もここで一緒に取れる。
  const counterpartyNumberQueries = useQueries({
    queries: transfers.map((t) => {
      const accountId = counterpartyAccountId(t);
      return {
        queryKey: ["account-number", accountId],
        queryFn: () => getAccountNumber(accountId),
        refetchInterval: POLL_INTERVAL_MS,
      };
    }),
  });

  const handleStarted = (started: { transferId: string }) => {
    setOpenForm(null);
    // transfer-history-projectorの反映を待たず、まず取れる分だけ即座に再確認する
    // (反映まではPOLL_INTERVAL_MSごとの自動ポーリングが拾う、AccountListScreenの
    // OpenAccountForm.onOpenedと同じ考え方)。
    void queryClient.invalidateQueries({ queryKey: ["my-transfers"] });
    onSelectTransfer(started.transferId);
  };

  return (
    <>
      <BrandAppBar
        customerName={customerName}
        pointsBalance={pointsBalance?.balance}
        onViewPointsHistory={onViewPointsHistory}
        onSignOut={() => {
          signOut();
          onSignedOut();
        }}
      />
      <div className="bank-body">
        <CustomerTabBar active="transfers" onSelect={onSelectTab} />

        {myTransfersQuery.isLoading ? (
          <div className="panel">
            <div className="skeleton skeleton-line" style={{ width: "60%" }} />
          </div>
        ) : transfers.length === 0 ? (
          <div className="panel">
            <p>まだ送金の依頼はありません。下から振替・振込を行ってください。</p>
          </div>
        ) : (
          <ul className="account-list">
            {transfers.map((t, i) => {
              const counterpartyNumber = counterpartyNumberQueries[i]?.data;
              const outgoing = isOutgoing(t);
              // furikaeは相手方が常に自分自身なので方向・名義を出さない(neutral/Bank)。
              const tone = t.kind === "furikae" ? "neutral" : outgoing ? "negative" : "positive";
              const Icon = t.kind === "furikae" ? Bank : outgoing ? ArrowUpRight : ArrowDownLeft;
              const numberLabel = counterpartyNumber
                ? `${counterpartyNumber.branchName} ${formatFriendlyAccountNumber(counterpartyNumber.accountNumber)}`
                : "確認しています…";
              const directionSuffix =
                counterpartyNumber && t.kind !== "furikae"
                  ? ` ${counterpartyNumber.ownerName}様${outgoing ? "へ" : "より"}`
                  : "";
              return (
                <li key={t.transferId}>
                  <button type="button" className="account-card" onClick={() => onSelectTransfer(t.transferId)}>
                    <span className="account-card-icon-row">
                      <span className={`tx-icon tx-icon-${tone}`}>
                        <Icon />
                      </span>
                      <span className="account-card-main">
                        <span className="account-card-name">{TRANSFER_KIND_LABEL[t.kind]}</span>
                        <span className="account-card-number">
                          {numberLabel}
                          {directionSuffix}
                        </span>
                      </span>
                    </span>
                    <span className="account-card-side">
                      <span className="account-card-balance">{formatCurrency(t.amount)}</span>
                      <span className={STATE_BADGE_CLASS[t.state]}>{TRANSFER_STATE_LABEL[t.state]}</span>
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
                onStarted={handleStarted}
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
