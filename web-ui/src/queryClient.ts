import { type DefaultOptions, QueryClient } from "@tanstack/react-query";

/**
 * テストでも本番と同じdefaultOptions(特にretry回数)を使うため、生成をファクトリで共有
 * する。`queriesOverride`はテストが実時間のバックオフ待ちを避けるためのものだけを想定
 * している(例: `retryDelay: 0`)。retry回数そのものは上書きしないこと。
 */
export function createQueryClient(queriesOverride?: Partial<DefaultOptions["queries"]>): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 書き込みは202 Acceptedのみで結果整合性(ADR-0001/0004/0006)。ポーリングで反映を
        // 待つUXをそのまま見せるのがこのマイルストーンの目的の一つなので、キャッシュを
        // 信用しすぎず短い間隔で取り直す。
        staleTime: 0,
        retry: 1,
        ...queriesOverride,
      },
    },
  });
}

export const queryClient = createQueryClient();
