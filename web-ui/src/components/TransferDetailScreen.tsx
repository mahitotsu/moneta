import { useMutation, useQuery } from "@tanstack/react-query";
import { DetailAppBar } from "./AppBar";
import { CustomerTabBar, type CustomerTab } from "./CustomerTabBar";
import { useTransfer } from "../hooks/useTransfer";
import { useAccountNumber } from "../hooks/useAccountNumber";
import { useSettlingMutation } from "../hooks/useSettlingMutation";
import { confirmTransfer, cancelTransfer, getMyAccounts, recallTransfer } from "../api/client";
import { formatCurrency, formatDateTime, formatFriendlyAccountNumber } from "../format";
import { TRANSFER_KIND_LABEL, TRANSFER_STATE_LABEL, type TransferState } from "../api/types";
import type { AccountNumberLookup } from "../api/types";

// crates/transfer-service/src/saga.rsのRECALL_WINDOWと同じ24時間。ここでの時刻比較は
// あくまで表示上のヒントであり、最終判定は常にサーバー側の`recall_eligibility`が権威
// (docs/adr/0012決定6)——期限切れの組戻し要求はサーバー側で却下される
// (docs/e2e-scenarios.md FC12, 旧J10)。
const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

// AccountListScreen/AccountView.tsxが自分の口座に使っているのと同じ「支店名 番号」の書式
// (docs/adr/0015)。以前はここだけ`formatAccountNumber`(accountIdのUUID末尾を口座番号風に
// 見せかける表示専用の飾り、実データとは無関係)を使っており、アプリの他画面が表示する
// 実際の口座番号と体裁が一致していなかった(docs/adr/0019)。`showName`がtrueの側(相手方、
// 振込/組戻しのみ)には名義(ownerName、docs/adr/0018)も添える——自分自身の側は自明なので
// 口座番号のみのまま(docs/adr/0020)。
function accountNumberLabel(accountNumber: AccountNumberLookup | null | undefined, showName: boolean): string {
  if (!accountNumber) return "口座番号を確認しています…";
  const base = `${accountNumber.branchName} ${formatFriendlyAccountNumber(accountNumber.accountNumber)}`;
  return showName ? `${base} / ${accountNumber.ownerName}様` : base;
}

// 送金元・送金先のうち自分の口座である側に、その口座の入出金履歴へのリンクを添える
// (docs/adr/0021)。furikaeは両方とも自分名義なので両方に付き、furikomi/組戻しは自分の側
// だけに付く——相手方の口座は他人のものであり閲覧導線を出すこと自体が不適切なため出さない。

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

// AWS/HTTP等の内部用語を出さない業務言語のみの文言(過去の指摘事項)。
const STATE_DESCRIPTION: Record<TransferState, string> = {
  pending_confirmation: "内容をご確認のうえ、確定または取消を選択してください。",
  pending_debit: "手続き中です。しばらくお待ちください。",
  pending_credit: "手続き中です。しばらくお待ちください。",
  compensating: "送金を取り消しています。しばらくお待ちください。",
  credited: "送金が完了しました。",
  compensated: "送金を取り消しました。送金元の残高は元に戻っています。",
  failed: "この送金は完了できませんでした。送金元の口座からの出金は行われていません。",
  cancelled: "この振込の依頼を取消しました。",
};

interface Props {
  transferId: string;
  onBack: () => void;
  /** タブバーは詳細画面にも常設する(docs/adr/0022)——「戻る」は常にこのタブの一覧へ戻る
   * だけの一定の意味にし、タブをまたぐ移動は常にタブバーの役目にする。 */
  onSelectTab: (tab: CustomerTab) => void;
  onRecalled: (newTransferId: string) => void;
  /** 送金元/送金先のうち自分の口座である側から、その口座の入出金履歴へ飛ぶ(docs/adr/0021)。 */
  onViewAccount: (accountId: string) => void;
}

/** 送金1件の状態を継続ポーリングしつつ、振込の確認/取消(pending_confirmation中のみ)・
 * 組戻し(credited済みの振込のみ、24時間以内)の操作を提供する(docs/adr/0012決定6)。 */
export function TransferDetailScreen({ transferId, onBack, onSelectTab, onRecalled, onViewAccount }: Props) {
  const { data, isLoading } = useTransfer(transferId);

  // 送金元・送金先それぞれの実際の口座番号(docs/adr/0015)。dataがまだ無い間は
  // useAccountNumberが自動的にクエリを止める(空文字列accountId、useAccountNumber.tsのenabled)。
  const { data: fromAccountNumber } = useAccountNumber(data?.fromAccountId ?? "");
  const { data: toAccountNumber } = useAccountNumber(data?.toAccountId ?? "");

  // 相手方(振込/組戻しのみ)の名義を出すために、自分の口座かどうかを判定する
  // (TransferListScreen.tsxと同じ理由、docs/adr/0020)。furikaeは送金元・送金先とも常に
  // 自分名義なので「相手方」という概念自体が無い。myAccountsが未反映の間は誤判定を避けるため
  // 名義を一切出さない(myAccountsReady)。
  const myAccountsQuery = useQuery({ queryKey: ["my-accounts"], queryFn: () => getMyAccounts() });
  const myAccountsReady = myAccountsQuery.data !== undefined;
  const myAccountIds = new Set((myAccountsQuery.data ?? []).map((a) => a.accountId));
  const isCrossOwner = data?.kind !== "furikae" && myAccountsReady;
  const fromIsCounterparty = isCrossOwner && data != null && !myAccountIds.has(data.fromAccountId);
  const toIsCounterparty = isCrossOwner && data != null && !myAccountIds.has(data.toAccountId);
  const isMine = (accountId: string) => myAccountsReady && myAccountIds.has(accountId);

  // 確認/取消はこのサガ自身の状態がpending_confirmationから遷移するのを待てば良いので、
  // 口座の凍結/解約と同じ「反映待ち」パターン(useSettlingMutation)がそのまま使える。
  const confirmMutation = useSettlingMutation(
    () => confirmTransfer(transferId),
    ["transfer", transferId],
    data?.state ?? "",
  );
  const cancelMutation = useSettlingMutation(
    () => cancelTransfer(transferId),
    ["transfer", transferId],
    data?.state ?? "",
  );

  // 組戻しは元のサガとは別の新しいサガ(新しいtransferId)として実行され、元のサガの状態は
  // 変わらないため、useSettlingMutationの「同じqueryKeyの値が変わるまで待つ」という前提が
  // 成立しない。組戻し自身の反映待ちは、遷移先のTransferDetailScreen(新しいtransferId)の
  // ポーリングに委ねる。
  const recallMutation = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("transfer not loaded yet");
      const newTransferId = crypto.randomUUID();
      await recallTransfer(newTransferId, transferId);
      // 組戻し自身も新しいtransferId(kind: recall)のサガとしてtransfer-history-projectorが
      // 拾う(docs/adr/0017)ため、ここでローカルに何かを記録する必要はない——「送金」タブの
      // 一覧はサーバー側の反映を自動的に(ポーリングで)拾う。
      return newTransferId;
    },
    onSuccess: onRecalled,
  });

  const withinRecallWindow = data ? Date.now() - new Date(data.updatedAt).getTime() < RECALL_WINDOW_MS : false;

  return (
    <>
      <DetailAppBar title="送金の詳細" onBack={onBack} backLabel="送金一覧へ戻る" />
      <div className="bank-body">
        <CustomerTabBar active="transfers" onSelect={onSelectTab} />
        {isLoading || !data ? (
          // 口座のAccountView(反映待ち)と同じ理由: 「まだ書き込みが反映されていない」正常な
          // 状態と「取得が一時的に失敗した」を区別せず、同じ穏やかな文言で表示する
          // (docs/adr/0004、[[eventual_consistency_not_a_failure]])。
          <div className="balance-hero">
            <p>
              この送金はまだ最新の情報に反映されていません。手続きの反映には少し時間がかかる
              場合があります。
            </p>
          </div>
        ) : (
          <>
            <div className="balance-hero">
              <div className="balance-hero-top">
                <span className="account-type">{TRANSFER_KIND_LABEL[data.kind]}</span>
                <span className={STATE_BADGE_CLASS[data.state]}>{TRANSFER_STATE_LABEL[data.state]}</span>
              </div>
              <div className="balance-row">
                <span className="balance-figure">{formatCurrency(data.amount)}</span>
              </div>
              <dl className="hero-meta">
                <dt>送金元</dt>
                <dd>
                  {accountNumberLabel(fromAccountNumber, fromIsCounterparty)}
                  {isMine(data.fromAccountId) && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="inline-link-button"
                        onClick={() => onViewAccount(data.fromAccountId)}
                      >
                        入出金履歴を見る
                      </button>
                    </>
                  )}
                </dd>
                <dt>送金先</dt>
                <dd>
                  {accountNumberLabel(toAccountNumber, toIsCounterparty)}
                  {isMine(data.toAccountId) && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="inline-link-button"
                        onClick={() => onViewAccount(data.toAccountId)}
                      >
                        入出金履歴を見る
                      </button>
                    </>
                  )}
                </dd>
                <dt>更新日時</dt>
                <dd>{formatDateTime(data.updatedAt)}</dd>
              </dl>
            </div>

            <div className="panel">
              <p>{STATE_DESCRIPTION[data.state]}</p>

              {data.state === "pending_confirmation" && (
                <>
                  <div className="field-row">
                    <button
                      type="button"
                      onClick={() => confirmMutation.mutate()}
                      disabled={confirmMutation.isBusy || cancelMutation.isBusy}
                    >
                      {confirmMutation.isBusy ? "処理中..." : "振込を確定する"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        if (window.confirm("この振込の依頼を取消します。よろしいですか?")) cancelMutation.mutate();
                      }}
                      disabled={confirmMutation.isBusy || cancelMutation.isBusy}
                    >
                      {cancelMutation.isBusy ? "処理中..." : "取消す"}
                    </button>
                  </div>
                  {confirmMutation.isError && (
                    <p className="status-line error">{(confirmMutation.error as Error).message}</p>
                  )}
                  {cancelMutation.isError && (
                    <p className="status-line error">{(cancelMutation.error as Error).message}</p>
                  )}
                </>
              )}

              {data.kind === "furikomi" && data.state === "credited" && withinRecallWindow && (
                <>
                  <button
                    type="button"
                    className="settings-item-action settings-item-action-danger"
                    onClick={() => {
                      if (window.confirm("この振込を組戻します。よろしいですか?")) recallMutation.mutate();
                    }}
                    disabled={recallMutation.isPending}
                  >
                    {recallMutation.isPending ? "処理中..." : "組戻す"}
                  </button>
                  {recallMutation.isError && (
                    <p className="status-line error">{(recallMutation.error as Error).message}</p>
                  )}
                  {recallMutation.isSuccess && (
                    <p className="status-line pending">組戻しを受け付けました。反映まで少し時間がかかります。</p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
