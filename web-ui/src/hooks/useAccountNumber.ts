import { useQuery } from "@tanstack/react-query";
import { getAccountNumber } from "../api/client";

// useAccount/useTransferと同じ考え方(反映ラグを見せつつも待たせすぎないポーリング間隔、
// docs/adr/0004)。口座開設直後はaccount-number-projectorがまだ反映していないことがあり、
// その間はnullが返る(docs/adr/0015)。
const POLL_INTERVAL_MS = 3000;

/** AccountView/AccountListScreenが「自分の口座番号(支店+7桁)」を表示するための共有フック
 * (useAccountと同じ形)。 */
export function useAccountNumber(accountId: string) {
  return useQuery({
    queryKey: ["account-number", accountId],
    queryFn: () => getAccountNumber(accountId),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
