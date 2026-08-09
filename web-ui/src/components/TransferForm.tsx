import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { startTransfer } from "../api/client";
import { ACCOUNT_ID_PATTERN, formatAccountNumber } from "../format";
import type { CustomerAccount } from "../customerSession";

export interface StartedTransfer {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
}

interface Props {
  /** 振替(自分の口座間、送金先も自分の口座一覧から選ぶ)/振込(名義不一致を想定し、送金先は
   * 口座IDを直接入力する)。実際に振替/振込のどちらとして扱われるかはサーバー側の名義突き合わせ
   * が決める(docs/adr/0011)——このpropはあくまでどちらの入力UIを見せるかの選択であり、
   * 送信するAPIリクエストの形は共通(docs/adr/0012決定4)。 */
  kind: "furikae" | "furikomi";
  accounts: CustomerAccount[];
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
  const [toAccountId, setToAccountId] = useState("");
  const [amount, setAmount] = useState("0.00");

  const toOptions = accounts.filter((a) => a.accountId !== fromAccountId);

  const mutation = useMutation({
    mutationFn: async () => {
      const transferId = crypto.randomUUID();
      await startTransfer(transferId, fromAccountId, toAccountId, amount);
      return { transferId, fromAccountId, toAccountId, amount };
    },
    onSuccess: onStarted,
  });

  const toAccountValid = kind === "furikae" ? toAccountId !== "" : ACCOUNT_ID_PATTERN.test(toAccountId);
  const canSubmit = fromAccountId !== "" && toAccountValid && fromAccountId !== toAccountId && !mutation.isPending;

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
            {a.nickname ?? "普通預金"} ●●●●{formatAccountNumber(a.accountId).slice(-4)}
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
                {a.nickname ?? "普通預金"} ●●●●{formatAccountNumber(a.accountId).slice(-4)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="transfer-to-furikomi">
            送金先の口座ID
          </label>
          <input
            id="transfer-to-furikomi"
            className="field-input-wide"
            placeholder="送金先の口座ID"
            value={toAccountId}
            onChange={(e) => setToAccountId(e.target.value)}
          />
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
