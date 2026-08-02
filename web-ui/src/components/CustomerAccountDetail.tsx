import { AccountView } from "./AccountView";
import { TransactionHistory } from "./TransactionHistory";
import { FreezeForm } from "./FreezeForm";
import { SimpleActionButton } from "./SimpleActionButton";
import { unfreeze, closeAccount } from "../api/client";

/**
 * 顧客向けの口座詳細画面。入出金ボタンは意図的に置かない——現実のネットバンキングと
 * 同様、顧客はWeb UIから直接入出金しない(入出金はATM/他行振込/収納機関からのみ発生する、
 * 「外部チャネル・エミュレータ」画面の役割、docs/adr/0009)。凍結・凍結解除・解約は
 * 顧客のセルフサービス操作として引き続きここに残す。
 */
export function CustomerAccountDetail({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  return (
    <>
      <button type="button" className="secondary" onClick={onBack}>
        ← 口座一覧へ戻る
      </button>
      <AccountView accountId={accountId} />
      <TransactionHistory accountId={accountId} />
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
  );
}
