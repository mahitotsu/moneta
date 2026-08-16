import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTransactionHistory } from "../api/client";
import { formatCurrency, formatDateLabel, formatTimeLabel } from "../format";
import { FREEZE_REASON_VIEW_LABEL, type TransactionEntry } from "../api/types";
import { ArrowDownLeft, ArrowUpRight, Lock, PlusCircle, Unlock, XCircle } from "./icons";

const POLL_INTERVAL_MS = 3000;

const TYPE_LABEL: Record<string, string> = {
  opened: "口座開設",
  deposited: "入金",
  withdrawn: "出金",
  frozen: "凍結",
  unfrozen: "凍結解除",
  closed: "解約",
};

const TYPE_ICON: Record<string, ReactNode> = {
  opened: <PlusCircle />,
  deposited: <ArrowDownLeft />,
  withdrawn: <ArrowUpRight />,
  frozen: <Lock />,
  unfrozen: <Unlock />,
  closed: <XCircle />,
};

const TYPE_TONE: Record<string, "positive" | "negative" | "neutral"> = {
  opened: "positive",
  deposited: "positive",
  withdrawn: "negative",
  frozen: "neutral",
  unfrozen: "neutral",
  closed: "neutral",
};

/** 通帳のように日付見出しでまとめる(取得順=新しい順を保ったまま、日付が変わる境目だけ区切る)。 */
function groupByDate(entries: TransactionEntry[]): { date: string; entries: TransactionEntry[] }[] {
  const groups: { date: string; entries: TransactionEntry[] }[] = [];
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

interface Props {
  accountId: string;
  /** 行が送金由来(transferId非null)の場合、その送金の詳細へ飛ぶ(docs/adr/0021)。 */
  onViewTransfer: (transferId: string) => void;
}

export function TransactionHistory({ accountId, onViewTransfer }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["transactions", accountId],
    queryFn: () => getTransactionHistory(accountId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (isLoading) {
    return (
      <div className="panel">
        <h2>取引履歴</h2>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
      </div>
    );
  }

  // AccountViewと同じ理由(結果整合性は仕様どおりの正常な状態であり、取得の一時的な
  // 失敗もrefetchIntervalが自動的に再試行するため)で、両者を区別せず同じ文言にする。
  if (!data || data.length === 0) {
    return (
      <div className="panel">
        <h2>取引履歴</h2>
        <p className="subtitle">まだ取引がありません。反映まで少し時間がかかる場合があります。</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>取引履歴(新しい順・最大50件)</h2>
      {groupByDate(data).map(({ date, entries }) => (
        <div className="tx-group" key={date}>
          <p className="tx-date">{date}</p>
          <ul className="tx-list">
            {entries.map((entry) => {
              const tone = TYPE_TONE[entry.type] ?? "neutral";
              return (
                <li className="tx-row" key={entry.eventId}>
                  <span className={`tx-icon tx-icon-${tone}`}>{TYPE_ICON[entry.type]}</span>
                  <span className="tx-main">
                    <span className="tx-type">{TYPE_LABEL[entry.type] ?? entry.type}</span>
                    {entry.reason && <span className="tx-reason">{FREEZE_REASON_VIEW_LABEL[entry.reason]}</span>}
                    <span className="tx-time">{formatTimeLabel(entry.occurredAt)}</span>
                    {entry.transferId && (
                      <button
                        type="button"
                        className="inline-link-button tx-transfer-link"
                        onClick={() => onViewTransfer(entry.transferId!)}
                      >
                        送金の詳細を見る
                      </button>
                    )}
                  </span>
                  <span className="tx-amounts">
                    {entry.amount && (
                      <span className={`tx-amount tx-amount-${tone}`}>
                        {tone === "negative" ? "−" : "+"}
                        {formatCurrency(entry.amount)}
                      </span>
                    )}
                    <span className="tx-balance">残高 {formatCurrency(entry.balanceAfter)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
