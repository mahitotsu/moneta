import { useState } from "react";
import { useAccount } from "../hooks/useAccount";
import { formatAccountNumber, formatCurrency, formatDateTime } from "../format";
import { FREEZE_REASON_VIEW_LABEL } from "../api/types";
import { Eye, EyeOff } from "./icons";
import { removeAccountFor } from "../customerSession";

const STATUS_LABEL: Record<string, string> = {
  active: "有効",
  frozen: "凍結中",
  closed: "解約済み",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  active: "badge badge-positive",
  frozen: "badge badge-pending",
  closed: "badge badge-neutral",
};

export function AccountView({
  accountId,
  customerName,
  onRemoved,
}: {
  accountId: string;
  customerName: string;
  onRemoved: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const { data, isLoading, isFetching, isSuccess } = useAccount(accountId);

  if (isLoading) {
    return (
      <div className="balance-hero">
        <div className="skeleton skeleton-line" style={{ width: "40%" }} />
        <div className="skeleton skeleton-line skeleton-balance" />
      </div>
    );
  }

  // isSuccess && data===nullは「確定して存在しない(404)」であり、下のまだ反映されて
  // いないだけのケースとは違って、待っても解決しない。ここだけは区別して、一覧から
  // 削除する手段を用意する(さもないと永久にこの画面から出られなくなる)。
  if (isSuccess && data === null) {
    return (
      <div className="balance-hero">
        <p>この口座は見つかりませんでした。</p>
        <button
          type="button"
          className="settings-item-action settings-item-action-danger"
          onClick={() => {
            removeAccountFor(customerName, accountId);
            onRemoved();
          }}
        >
          一覧から削除する
        </button>
      </div>
    );
  }

  // dataが無い間は、理由が「まだ書き込みが反映されていない(結果整合性、docs/adr/0004の
  // 仕様どおりの正常な状態)」でも「取得が一時的に失敗した」でも、利用者から見れば同じ
  // 「まだ表示できていない」でしかない。後者はrefetchIntervalが自動的に再試行するため、
  // ここで「失敗しました」と言い切ると、仕様どおりの正常な待ち状態まで壊れているかの
  // ように見せてしまう。よって両者を区別せず同じ穏やかな文言で表示する。
  if (!data) {
    return (
      <div className="balance-hero">
        <p>
          この口座はまだ最新の情報に反映されていません。手続きの反映には少し時間がかかる
          場合があります(最大で約1分程度)。
        </p>
        <p className="hero-refetch-status">
          <span className={`live-dot${isFetching ? " live-dot-active" : ""}`} aria-hidden="true" />
          自動的に再確認しています
        </p>
      </div>
    );
  }

  return (
    <div className="balance-hero">
      <div className="balance-hero-top">
        <span className="account-type">普通預金 ●●●●{formatAccountNumber(accountId).slice(-4)}</span>
        <span className="hero-top-right">
          <span
            className={`live-dot${isFetching ? " live-dot-active" : ""}`}
            aria-hidden="true"
            title="自動更新中"
          />
          <span className={STATUS_BADGE_CLASS[data.status]}>{STATUS_LABEL[data.status]}</span>
        </span>
      </div>
      <div className="balance-row">
        <span className="balance-figure">{hidden ? "¥ ••••••••" : formatCurrency(data.balance)}</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => setHidden((h) => !h)}
          aria-label={hidden ? "残高を表示" : "残高を隠す"}
        >
          {hidden ? <EyeOff /> : <Eye />}
        </button>
      </div>
      {data.status === "frozen" && (
        <dl className="hero-meta">
          <dt>凍結理由</dt>
          <dd>{FREEZE_REASON_VIEW_LABEL[data.frozenReason]}</dd>
          <dt>凍結日時</dt>
          <dd>{formatDateTime(data.frozenAt)}</dd>
        </dl>
      )}
      {data.status === "closed" && (
        <dl className="hero-meta">
          <dt>解約日時</dt>
          <dd>{formatDateTime(data.closedAt)}</dd>
        </dl>
      )}
    </div>
  );
}
