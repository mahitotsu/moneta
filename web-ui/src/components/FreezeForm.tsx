import { useState } from "react";
import { freeze } from "../api/client";
import { FREEZE_REASONS, type FreezeReasonRequest } from "../api/types";
import { Lock } from "./icons";
import { useSettlingMutation } from "../hooks/useSettlingMutation";

export function FreezeForm({ accountId, currentStatus }: { accountId: string; currentStatus: string }) {
  const [reason, setReason] = useState<FreezeReasonRequest>(FREEZE_REASONS[0].value);
  const { mutate, isBusy, isSettling, isError, error } = useSettlingMutation(
    () => freeze(accountId, reason),
    ["account", accountId],
    currentStatus,
  );

  return (
    <form
      className="settings-item"
      onSubmit={(e) => {
        e.preventDefault();
        mutate();
      }}
    >
      <div className="settings-item-header">
        <span className="settings-item-icon">
          <Lock />
        </span>
        <div>
          <p className="settings-item-title">口座を凍結する</p>
          <p className="settings-item-desc">不正利用が疑われる場合などに、この口座を一時的に凍結します。</p>
        </div>
      </div>
      <div className="chip-group" role="radiogroup" aria-label="凍結理由">
        {FREEZE_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={reason === r.value}
            className={`chip ${reason === r.value ? "chip-selected" : ""}`}
            onClick={() => setReason(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <button type="submit" className="settings-item-action" disabled={isBusy}>
        {isBusy ? "処理中..." : "凍結する"}
      </button>
      {isError && <p className="status-line error">{(error as Error).message}</p>}
      {isSettling && <p className="status-line pending">受理されました。反映まで少し時間がかかります。</p>}
    </form>
  );
}
