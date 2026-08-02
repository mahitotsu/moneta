import { useQuery } from "@tanstack/react-query";
import { getAccount } from "../api/client";

// 反映ラグ(結果整合性、docs/adr/0004)を見せつつも待たせすぎないポーリング間隔。
const POLL_INTERVAL_MS = 3000;

/** AccountViewとCustomerAccountDetailの両方が同じ口座データを必要とするため共有する
 * (queryKeyが同じなのでTanStack Query側でリクエストは重複しない)。 */
export function useAccount(accountId: string) {
  return useQuery({
    queryKey: ["account", accountId],
    queryFn: () => getAccount(accountId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
