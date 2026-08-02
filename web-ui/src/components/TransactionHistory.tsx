import { useQuery } from "@tanstack/react-query";
import { getTransactionHistory } from "../api/client";

const POLL_INTERVAL_MS = 3000;

const TYPE_LABEL: Record<string, string> = {
  opened: "口座開設",
  deposited: "入金",
  withdrawn: "出金",
  frozen: "凍結",
  unfrozen: "凍結解除",
  closed: "解約",
};

export function TransactionHistory({ accountId }: { accountId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions", accountId],
    queryFn: () => getTransactionHistory(accountId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (isLoading) {
    return <p>読み込み中...</p>;
  }

  if (error) {
    return <p className="status-line error">{(error as Error).message}</p>;
  }

  if (!data || data.length === 0) {
    return (
      <div className="panel">
        <h2>取引履歴</h2>
        <p>まだ取引がありません。</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>取引履歴(新しい順・最大50件)</h2>
      <ul className="transaction-list">
        {data.map((entry) => (
          <li key={entry.eventId}>
            <span className="transaction-type">{TYPE_LABEL[entry.type] ?? entry.type}</span>
            {entry.amount && <span className="transaction-amount">{entry.amount}</span>}
            <span className="transaction-balance">残高 {entry.balanceAfter}</span>
            <span className="transaction-time">{entry.occurredAt}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
