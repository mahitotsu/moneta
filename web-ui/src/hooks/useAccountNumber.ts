import { useQuery } from "@tanstack/react-query";
import { getAccountNumber } from "../api/client";

// useAccount/useTransferと同じ考え方(反映ラグを見せつつも待たせすぎないポーリング間隔、
// docs/adr/0004)。口座開設直後はaccount-number-projectorがまだ反映していないことがあり、
// その間はnullが返る(docs/adr/0015)。
const POLL_INTERVAL_MS = 3000;

/** AccountView/AccountListScreenが「自分の口座番号(支店+7桁)」を表示するための共有フック
 * (useAccountと同じ形)。振込の送金元・送金先の表示(TransferDetailScreen.tsx)にも使う
 * ——このAPI自体は「このaccountIdの口座番号は何か」を答えるだけで所有者を問わない
 * (docs/adr/0015、AccountNumberQueryApiはCognito認証さえあれば任意のaccountIdを解決できる)。
 * `accountId`がまだ確定していない呼び出し元(親のデータがロード中)向けに、空文字列なら
 * クエリ自体を発行しない。 */
export function useAccountNumber(accountId: string) {
  return useQuery({
    queryKey: ["account-number", accountId],
    queryFn: () => getAccountNumber(accountId),
    refetchInterval: POLL_INTERVAL_MS,
    enabled: accountId !== "",
  });
}
