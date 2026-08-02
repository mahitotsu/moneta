import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

// 反映待ちが詰まった場合の保険。時間切れで強制解除されても、再送信の安全性はバックエンド側の
// Idempotency-Key/ドメイン層の状態チェックが担保するので、フロント側は「操作可能に戻す」ことを
// 優先してよい。
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * コマンド送信(mutationFn)が成功した後、対象口座のステータス(currentStatus、呼び出し側の
 * useQueryが継続ポーリングして渡してくる最新値)がクリック時点の値から実際に変わるまで
 * ボタンを非活性に保つための共有フック(SimpleActionButton/FreezeFormで共通)。
 *
 * 「invalidateQueriesのPromiseがresolveしたら解除」という以前の実装は誤りだった: それは
 * 「GETが1回返ってきた」ことしか意味せず、結果整合性のラグ(docs/adr/0004)により、まだ古い
 * ステータスのまま返ってくることがある。それを解除条件にすると、実際にはまだ反映されて
 * いないのにボタンが再度押せる状態に戻ってしまう(実際に踏んだ不具合)。そのため解除条件は
 * 必ず「表示されているステータスの値そのものが変わったか」で判定する。
 */
export function useSettlingMutation(
  mutationFn: () => Promise<unknown>,
  queryKey: QueryKey,
  currentStatus: string,
) {
  const queryClient = useQueryClient();
  const [isSettling, setIsSettling] = useState(false);
  const statusAtClickRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const clearSettleTimeout = useCallback(() => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  }, []);

  // アンマウント時にタイマーが残らないようにする(次のマウントと混線させないため)。
  useEffect(() => clearSettleTimeout, [clearSettleTimeout]);

  // currentStatusはaccount-service→outbox→EventBridge→Query serviceの反映を待つポーリング
  // (useAccountのrefetchInterval)で更新されてくる。クリック時点の値と実際に異なった時点が
  // 「反映された」瞬間なので、ここでのみ非活性を解除する。
  useEffect(() => {
    if (isSettling && currentStatus !== statusAtClickRef.current) {
      clearSettleTimeout();
      setIsSettling(false);
    }
  }, [currentStatus, isSettling, clearSettleTimeout]);

  const mutation = useMutation({
    mutationFn,
    // 反映を早めるための一押し(無くても上のuseEffectとポーリングだけで最終的には解除される)。
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: () => {
      clearSettleTimeout();
      setIsSettling(false);
    },
  });

  const mutate = useCallback(() => {
    statusAtClickRef.current = currentStatus;
    clearSettleTimeout();
    setIsSettling(true);
    timeoutRef.current = setTimeout(() => setIsSettling(false), SETTLE_TIMEOUT_MS);
    mutation.mutate();
  }, [currentStatus, clearSettleTimeout, mutation]);

  return {
    mutate,
    isPending: mutation.isPending,
    isSettling,
    isBusy: mutation.isPending || isSettling,
    isError: mutation.isError,
    error: mutation.error,
  };
}
