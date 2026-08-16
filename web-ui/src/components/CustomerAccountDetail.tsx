import { useState } from "react";
import { AccountView } from "./AccountView";
import { TransactionHistory } from "./TransactionHistory";
import { FreezeForm } from "./FreezeForm";
import { SimpleActionButton } from "./SimpleActionButton";
import { DetailAppBar } from "./AppBar";
import { ChevronDown, Unlock, XCircle } from "./icons";
import { unfreeze, closeAccount } from "../api/client";
import { useAccount } from "../hooks/useAccount";

/**
 * 顧客向けの口座詳細画面。入出金ボタンは意図的に置かない——現実のネットバンキングと
 * 同様、顧客はWeb UIから直接入出金しない(入出金はATM/他行振込/収納機関からのみ発生する、
 * 「外部チャネル・エミュレータ」画面の役割、docs/adr/0009)。凍結・凍結解除・解約は
 * 顧客のセルフサービス操作として引き続きここに残すが、実際の銀行アプリに合わせて
 * 「口座を管理」の折りたたみセクションの下に置く(取引明細より目立たせない)。
 *
 * どの操作を出すかは`account-domain`の状態遷移(`Account::apply`)と一致させる——
 * Activeでは Freeze/Close のみ有効(Unfreezeは`AlreadyActive`で拒否)、Frozenでは
 * Unfreeze/Close のみ有効(Freezeは`AlreadyFrozen`で拒否)、Closedはどのコマンドも
 * `AccountClosed`で拒否される終端状態なので管理セクション自体を出さない。
 */
export function CustomerAccountDetail({
  accountId,
  onBack,
  onViewTransfer,
}: {
  accountId: string;
  onBack: () => void;
  /** 取引履歴の1行が送金由来の場合、その送金の詳細へ飛ぶ(docs/adr/0021)。 */
  onViewTransfer: (transferId: string) => void;
}) {
  const [managingOpen, setManagingOpen] = useState(false);
  const { data: account, isSuccess } = useAccount(accountId);
  const isMissing = isSuccess && account === null;

  return (
    <>
      <DetailAppBar title="口座詳細" onBack={onBack} />
      <div className="bank-body">
        <AccountView accountId={accountId} onRemoved={onBack} />
        {!isMissing && <TransactionHistory accountId={accountId} onViewTransfer={onViewTransfer} />}

        {account && account.status !== "closed" && (
          <section className="panel settings-panel">
            <button
              type="button"
              className="settings-toggle"
              onClick={() => setManagingOpen((o) => !o)}
              aria-expanded={managingOpen}
            >
              <span>口座を管理</span>
              <span className={managingOpen ? "chevron chevron-open" : "chevron"}>
                <ChevronDown />
              </span>
            </button>
            {managingOpen && (
              <div className="settings-list">
                {account.status === "active" && <FreezeForm accountId={accountId} currentStatus={account.status} />}
                {account.status === "frozen" && (
                  <SimpleActionButton
                    accountId={accountId}
                    currentStatus={account.status}
                    icon={<Unlock />}
                    title="凍結を解除する"
                    description="この口座の凍結を解除し、通常どおり利用できる状態に戻します。"
                    submitLabel="凍結を解除する"
                    action={unfreeze}
                  />
                )}
                <SimpleActionButton
                  accountId={accountId}
                  currentStatus={account.status}
                  icon={<XCircle />}
                  title="口座を解約する"
                  description="この口座を解約します。解約後は取引できなくなります。"
                  submitLabel="口座を解約する"
                  confirmMessage="この口座を解約します。よろしいですか?"
                  variant="danger"
                  action={closeAccount}
                />
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
