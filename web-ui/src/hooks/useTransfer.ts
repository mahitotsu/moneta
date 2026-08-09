import { useQuery } from "@tanstack/react-query";
import { getTransferStatus } from "../api/client";

// useAccountと同じ考え方(反映ラグを見せつつも待たせすぎないポーリング間隔、docs/adr/0004)。
// TransferStatusViewの反映ラグ自体はDynamoDB Streams駆動でさらに短いが(docs/adr/0012決定1の
// トレードオフ)、間隔を分ける理由はないので同じ値を使う。
const POLL_INTERVAL_MS = 3000;

/** TransferListScreen/TransferDetailScreenが送金状態をポーリングする共有フック
 * (useAccountと同じ形、docs/adr/0010決定5の「反映待ち」ポーリングUX)。 */
export function useTransfer(transferId: string) {
  return useQuery({
    queryKey: ["transfer", transferId],
    queryFn: () => getTransferStatus(transferId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
