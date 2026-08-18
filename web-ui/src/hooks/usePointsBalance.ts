import { useQuery } from "@tanstack/react-query";
import { getMyPoints } from "../api/client";

// useAccountNumberと同じ考え方(反映ラグを見せつつも待たせすぎないポーリング間隔、docs/adr/0004)。
const POLL_INTERVAL_MS = 3000;

/**
 * ヘッダー(`BrandAppBar`)にポイント残高を常設するための共有フック(docs/adr/0025)。
 * `useAccountNumber`と違い`accountId`のような画面固有のパラメータを持たないため、
 * クエリキーは単一の`["points"]`——`AccountListScreen`/`TransferListScreen`のどちらから
 * 呼んでも同じキャッシュを共有し、重複フェッチしない。
 */
export function usePointsBalance() {
  return useQuery({
    queryKey: ["points"],
    queryFn: () => getMyPoints(),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
