import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { freeze } from "../api/client";
import { FREEZE_REASONS, type FreezeReasonRequest } from "../api/types";
import { Lock } from "./icons";

export function FreezeForm({ accountId }: { accountId: string }) {
  const [reason, setReason] = useState<FreezeReasonRequest>(FREEZE_REASONS[0].value);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => freeze(accountId, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
  });

  return (
    <form
      className="settings-item"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
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
      <button type="submit" className="settings-item-action" disabled={mutation.isPending}>
        凍結する
      </button>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
      {mutation.isSuccess && <p className="status-line pending">受理されました。反映まで少し時間がかかります。</p>}
    </form>
  );
}
