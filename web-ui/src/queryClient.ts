import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 書き込みは202 Acceptedのみで結果整合性(ADR-0001/0004/0006)。ポーリングで反映を
      // 待つUXをそのまま見せるのがこのマイルストーンの目的の一つなので、キャッシュを
      // 信用しすぎず短い間隔で取り直す。
      staleTime: 0,
      retry: 1,
    },
  },
});
