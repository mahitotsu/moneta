import { useState } from "react";
import { useMutation, useQueries } from "@tanstack/react-query";
import { getAccountNumber, lookupAccountByNumber, startTransfer } from "../api/client";
import {
  ACCOUNT_NUMBER_PATTERN,
  formatFriendlyAccountNumber,
  normalizeAccountNumberInput,
} from "../format";
import { BRANCH_OPTIONS } from "../branches";
import type { AccountNumberLookup, MyAccount } from "../api/types";

// AccountListScreenのnumberQueriesと同じ間隔(docs/adr/0015)。
const POLL_INTERVAL_MS = 3000;

export interface StartedTransfer {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
}

interface Props {
  /** 振替(自分の口座間、送金先も自分の口座一覧から選ぶ)/振込(名義不一致を想定し、送金先は
   * 支店+口座番号から検索する、docs/adr/0015)。実際に振替/振込のどちらとして扱われるかは
   * サーバー側の名義突き合わせが決める(docs/adr/0011)——このpropはあくまでどちらの入力UIを
   * 見せるかの選択であり、送信するAPIリクエストの形は共通(docs/adr/0012決定4)。 */
  kind: "furikae" | "furikomi";
  accounts: MyAccount[];
  onStarted: (started: StartedTransfer) => void;
}

const TITLE: Record<Props["kind"], string> = {
  furikae: "振替(自分の口座間)",
  furikomi: "振込(他の名義の口座へ)",
};
const SUBMIT_LABEL: Record<Props["kind"], string> = {
  furikae: "振替を実行する",
  furikomi: "振込を依頼する",
};

/** 既存のAmountOperationForm(口座選択→金額入力→確認)と同じ構成の、振替/振込共有フォーム
 * (docs/adr/0012決定6)。`transferId`はクライアント側で生成する(ADR-0006決定2/ADR-0012決定4と
 * 同じ理由)。 */
export function TransferForm({ kind, accounts, onStarted }: Props) {
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.accountId ?? "");

  // furikae(自分の口座間): 自分の口座一覧から選ぶだけなので今まで通り。
  const [toAccountId, setToAccountId] = useState("");
  const toOptions = accounts.filter((a) => a.accountId !== fromAccountId);

  // 送金元・送金先(furikae)の選択肢に、AccountListScreen/AccountView.tsxと同じ「支店名 番号」の
  // 実際の口座番号を出す(docs/adr/0015)。以前はaccountIdのUUID末尾を口座番号風に見せかける
  // だけの表示専用の飾りを使っており、アプリの他画面と体裁が一致していなかった(docs/adr/0019)。
  const numberQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ["account-number", a.accountId],
      queryFn: () => getAccountNumber(a.accountId),
      refetchInterval: POLL_INTERVAL_MS,
    })),
  });
  const numberByAccountId = new Map(accounts.map((a, i) => [a.accountId, numberQueries[i]?.data]));
  const accountOptionLabel = (accountId: string): string => {
    const n = numberByAccountId.get(accountId);
    return n ? `普通預金 ${n.branchName} ${formatFriendlyAccountNumber(n.accountNumber)}` : "普通預金(口座番号を確認中…)";
  };

  // furikomi(他の名義の口座へ): 生UUID直接入力の代わりに、支店+口座番号(docs/adr/0015)から
  // 検索して名義を確認するフローにする。
  const [destinationBranchCode, setDestinationBranchCode] = useState(BRANCH_OPTIONS[0]?.code ?? "");
  const [destinationNumber, setDestinationNumber] = useState("");
  const [resolvedAccount, setResolvedAccount] = useState<AccountNumberLookup | null | undefined>(undefined);

  const lookupMutation = useMutation({
    mutationFn: (accountNumber: string) => lookupAccountByNumber(accountNumber),
    onSuccess: setResolvedAccount,
  });

  const resetLookup = () => {
    setResolvedAccount(undefined);
  };

  const branchMismatch =
    resolvedAccount != null && resolvedAccount.branchCode !== destinationBranchCode;

  const effectiveToAccountId = kind === "furikae" ? toAccountId : (resolvedAccount?.accountId ?? "");

  const [amount, setAmount] = useState("0.00");

  const mutation = useMutation({
    mutationFn: async () => {
      const transferId = crypto.randomUUID();
      await startTransfer(transferId, fromAccountId, effectiveToAccountId, amount);
      return { transferId, fromAccountId, toAccountId: effectiveToAccountId, amount };
    },
    onSuccess: onStarted,
  });

  const toAccountValid =
    kind === "furikae" ? toAccountId !== "" : resolvedAccount != null && !branchMismatch;
  const canSubmit =
    fromAccountId !== "" &&
    toAccountValid &&
    fromAccountId !== effectiveToAccountId &&
    !mutation.isPending;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) mutation.mutate();
      }}
    >
      <h2>{TITLE[kind]}</h2>

      <label className="field-label" htmlFor={`transfer-from-${kind}`}>
        送金元の口座
      </label>
      <select
        id={`transfer-from-${kind}`}
        className="field-input-wide"
        value={fromAccountId}
        onChange={(e) => setFromAccountId(e.target.value)}
      >
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId}>
            {accountOptionLabel(a.accountId)}
          </option>
        ))}
      </select>

      {kind === "furikae" ? (
        <>
          <label className="field-label" htmlFor="transfer-to-furikae">
            送金先の口座
          </label>
          <select
            id="transfer-to-furikae"
            className="field-input-wide"
            value={toAccountId}
            onChange={(e) => setToAccountId(e.target.value)}
          >
            <option value="">選択してください</option>
            {toOptions.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {accountOptionLabel(a.accountId)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="transfer-to-branch-furikomi">
            送金先の支店
          </label>
          <select
            id="transfer-to-branch-furikomi"
            className="field-input-wide"
            value={destinationBranchCode}
            onChange={(e) => {
              setDestinationBranchCode(e.target.value);
              resetLookup();
            }}
          >
            {BRANCH_OPTIONS.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}({b.code})
              </option>
            ))}
          </select>

          <label className="field-label" htmlFor="transfer-to-number-furikomi">
            送金先の口座番号
          </label>
          <div className="field-row">
            <input
              id="transfer-to-number-furikomi"
              className="field-input-wide"
              placeholder="口座番号(7桁)"
              value={destinationNumber}
              onChange={(e) => {
                setDestinationNumber(normalizeAccountNumberInput(e.target.value));
                resetLookup();
              }}
            />
            <button
              type="button"
              disabled={!ACCOUNT_NUMBER_PATTERN.test(destinationNumber) || lookupMutation.isPending}
              onClick={() => lookupMutation.mutate(destinationNumber)}
            >
              確認する
            </button>
          </div>

          {lookupMutation.isPending && <p className="status-line">口座を確認しています…</p>}

          {resolvedAccount === null && (
            <p className="status-line error">
              この口座番号の口座が見つかりませんでした。番号をご確認のうえ、時間をおいて再度お試しください。
            </p>
          )}

          {resolvedAccount != null && branchMismatch && (
            <p className="status-line error">支店が一致しません。支店・口座番号をご確認ください。</p>
          )}

          {resolvedAccount != null && !branchMismatch && (
            <p className="status-line">
              宛先名義: {resolvedAccount.ownerName} / {resolvedAccount.branchName}(
              {resolvedAccount.branchCode}) {formatFriendlyAccountNumber(resolvedAccount.accountNumber)}
            </p>
          )}
        </>
      )}

      <label className="field-label" htmlFor={`transfer-amount-${kind}`}>
        金額
      </label>
      <div className="field-row">
        <input
          id={`transfer-amount-${kind}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
        <button type="submit" disabled={!canSubmit}>
          {SUBMIT_LABEL[kind]}
        </button>
      </div>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
    </form>
  );
}
