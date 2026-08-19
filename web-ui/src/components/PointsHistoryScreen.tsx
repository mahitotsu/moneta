import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getMyPointsHistory } from "../api/client";
import { usePointsBalance } from "../hooks/usePointsBalance";
import { formatDateLabel, formatTimeLabel } from "../format";
import type { PointsHistoryEntry } from "../api/types";
import { ArrowDownLeft, ArrowUpRight, Star } from "./icons";
import { DetailAppBar } from "./AppBar";
import { CustomerTabBar, type CustomerTab } from "./CustomerTabBar";

// TransactionHistoryと同じ反映ラグの見せ方(docs/adr/0004)。
const POLL_INTERVAL_MS = 3000;

const TYPE_LABEL: Record<PointsHistoryEntry["type"], string> = {
  reserved: "手数料へ充当",
  awarded: "振込受取で付与",
  refunded: "送金失敗により返却",
};

// reserved(充当)だけが減る方向、awarded/refundedはどちらも増える方向(docs/adr/0026)。
// TransactionHistoryのdeposited(green)/withdrawn(red)と同じ「増える=緑・減る=赤」の配色を継承する。
const TYPE_ICON: Record<PointsHistoryEntry["type"], ReactNode> = {
  reserved: <ArrowUpRight />,
  awarded: <ArrowDownLeft />,
  refunded: <ArrowDownLeft />,
};

const TYPE_TONE: Record<PointsHistoryEntry["type"], "positive" | "negative"> = {
  reserved: "negative",
  awarded: "positive",
  refunded: "positive",
};

/** TransactionHistoryのgroupByDateと同じ考え方(通帳のように日付見出しでまとめる)。 */
function groupByDate(entries: PointsHistoryEntry[]): { date: string; entries: PointsHistoryEntry[] }[] {
  const groups: { date: string; entries: PointsHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const date = formatDateLabel(entry.occurredAt);
    const current = groups.at(-1);
    if (current && current.date === date) {
      current.entries.push(entry);
    } else {
      groups.push({ date, entries: [entry] });
    }
  }
  return groups;
}

/**
 * ポイント履歴画面(docs/adr/0026)。`BrandAppBar`のポイントバッジをタップして開く
 * ——「口座」「送金」と並ぶ3つ目の常設タブにはしない設計判断(ADR-0022を崩さない、
 * 副次的な情報のため)。`CustomerAccountDetail`/`TransactionHistory`と同じ形の
 * DetailAppBar+CustomerTabBar+履歴一覧。
 */
export function PointsHistoryScreen({
  onBack,
  activeTab,
  onSelectTab,
  onViewTransfer,
}: {
  onBack: () => void;
  /** どちらのタブから開かれたか(CustomerFlowのactiveTabをそのまま渡す)——タブは変更しない
   *  ため、開いた時点のタブがそのままタブバーのハイライトになる。 */
  activeTab: CustomerTab;
  onSelectTab: (tab: CustomerTab) => void;
  /** 履歴の1行から、その原因となった送金の詳細へ飛ぶ(ADR-0021と同じ相互リンクの考え方)。 */
  onViewTransfer: (transferId: string) => void;
}) {
  const { data: balance } = usePointsBalance();
  const { data: entries, isLoading } = useQuery({
    queryKey: ["pointsHistory"],
    queryFn: () => getMyPointsHistory(),
    refetchInterval: POLL_INTERVAL_MS,
  });

  return (
    <>
      <DetailAppBar title="ポイント履歴" onBack={onBack} backLabel="戻る" />
      <div className="bank-body">
        <CustomerTabBar active={activeTab} onSelect={onSelectTab} />

        <div className="balance-hero">
          <div className="balance-hero-top">
            <span className="account-type">
              <Star width={14} height={14} style={{ verticalAlign: "-2px" }} /> 現在の保有ポイント
            </span>
          </div>
          <div className="balance-row">
            <span className="balance-figure">{balance ? `${balance.balance}pt` : "…"}</span>
          </div>
        </div>

        {isLoading && (
          <div className="panel">
            <h2>履歴</h2>
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
          </div>
        )}

        {!isLoading && (!entries || entries.length === 0) && (
          <div className="panel">
            <h2>履歴</h2>
            <p className="subtitle">まだポイントの獲得・利用がありません。</p>
          </div>
        )}

        {!isLoading && entries && entries.length > 0 && (
          <div className="panel">
            <h2>履歴(新しい順・最大50件)</h2>
            {groupByDate(entries).map(({ date, entries: dayEntries }) => (
              <div className="tx-group" key={date}>
                <p className="tx-date">{date}</p>
                <ul className="tx-list">
                  {dayEntries.map((entry) => {
                    const tone = TYPE_TONE[entry.type];
                    return (
                      <li className="tx-row" key={entry.eventId}>
                        <span className={`tx-icon tx-icon-${tone}`}>{TYPE_ICON[entry.type]}</span>
                        <span className="tx-main">
                          <span className="tx-type">{TYPE_LABEL[entry.type]}</span>
                          <span className="tx-time">{formatTimeLabel(entry.occurredAt)}</span>
                          <button
                            type="button"
                            className="inline-link-button tx-transfer-link"
                            onClick={() => onViewTransfer(entry.transferId)}
                          >
                            送金の詳細を見る
                          </button>
                        </span>
                        <span className="tx-amounts">
                          <span className={`tx-amount tx-amount-${tone}`}>
                            {tone === "negative" ? "−" : "+"}
                            {entry.amount}pt
                          </span>
                          <span className="tx-balance">残高 {entry.balanceAfter}pt</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
