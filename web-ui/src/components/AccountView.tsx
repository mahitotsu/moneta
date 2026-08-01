import { useQuery } from "@tanstack/react-query";
import { getAccount } from "../api/client";

// 反映ラグ(最大約1分、docs/adr/0004)を見せつつも待たせすぎないポーリング間隔。
const POLL_INTERVAL_MS = 3000;

const STATUS_LABEL: Record<string, string> = {
  active: "有効",
  frozen: "凍結中",
  closed: "解約済み",
};

export function AccountView({ accountId }: { accountId: string }) {
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["account", accountId],
    queryFn: () => getAccount(accountId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (isLoading) {
    return <p>読み込み中...</p>;
  }

  if (error) {
    return <p className="status-line error">{(error as Error).message}</p>;
  }

  if (!data) {
    return (
      <div className="panel">
        <p>
          この口座はまだ照会結果に反映されていません。書き込みは非同期のため、DynamoDBへの
          反映まで最大約1分かかることがあります(docs/adr/0004)。
        </p>
        {isFetching && <span className="badge">再確認中...</span>}
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        口座の状態 {isFetching && <span className="badge">更新中</span>}
      </h2>
      <dl className="account-view">
        <dt>口座ID</dt>
        <dd>{accountId}</dd>
        <dt>状態</dt>
        <dd>{STATUS_LABEL[data.status]}</dd>
        <dt>残高</dt>
        <dd>{data.balance}</dd>
        {data.status === "frozen" && (
          <>
            <dt>凍結理由</dt>
            <dd>{data.frozenReason}</dd>
            <dt>凍結日時</dt>
            <dd>{data.frozenAt}</dd>
          </>
        )}
        {data.status === "closed" && (
          <>
            <dt>解約日時</dt>
            <dd>{data.closedAt}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
