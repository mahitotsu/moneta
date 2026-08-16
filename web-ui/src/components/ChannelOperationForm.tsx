import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Channel, CommandAcceptedResponse } from "../api/types";

interface Props {
  title: string;
  description: string;
  submitLabel: string;
  /** 表示のみの飾り項目(送金元銀行名・支払先名等)。バックエンドへは送らない(docs/adr/0009)。 */
  counterpartyLabel?: string;
  /** どの外部チャネルからの操作かを示す値。バックエンドへ送り、取引履歴に発生源として
   *  表示される(docs/adr/0023)——counterpartyLabelとは違い、こちらは実データとして送る。 */
  channel: Channel;
  action: (accountId: string, amount: string, channel: Channel) => Promise<CommandAcceptedResponse>;
}

/**
 * 「外部チャネル」(ATM/他行からの振込/収納機関への支払い)を模擬する共有フォーム。
 * 対象口座IDを直接入力する点が顧客向け画面と異なる——顧客のサインインセッションとは
 * 無関係な、「外の世界」からの操作を表す。中身は既存のDeposit/Withdrawコマンドを
 * そのまま呼ぶだけで、バックエンドは無改修(docs/adr/0009。channelの追加はドメインでは
 * なくエンベロープ側のメタデータなので、この決定を覆すものではない、docs/adr/0023)。
 */
export function ChannelOperationForm({ title, description, submitLabel, counterpartyLabel, channel, action }: Props) {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [counterparty, setCounterparty] = useState("");
  const mutation = useMutation({
    mutationFn: () => action(accountId, amount, channel),
  });

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <h2>{title}</h2>
      <p className="subtitle">{description}</p>
      <div className="field-row">
        <input
          placeholder="対象の口座ID"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>
      {counterpartyLabel && (
        <div className="field-row">
          <input
            placeholder={counterpartyLabel}
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
          />
        </div>
      )}
      <div className="field-row">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button type="submit" disabled={mutation.isPending || accountId.trim() === ""}>
          {submitLabel}
        </button>
      </div>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
      {mutation.isSuccess && <p className="status-line pending">受理されました。反映まで少し時間がかかります。</p>}
    </form>
  );
}
