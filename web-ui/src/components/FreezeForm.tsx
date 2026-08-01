import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { freeze } from "../api/client";
import { FREEZE_REASONS, type FreezeReasonRequest } from "../api/types";

export function FreezeForm({ accountId }: { accountId: string }) {
  const [reason, setReason] = useState<FreezeReasonRequest>(FREEZE_REASONS[0].value);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => freeze(accountId, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
  });

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <h2>口座を凍結</h2>
      <div className="field-row">
        <select value={reason} onChange={(e) => setReason(e.target.value as FreezeReasonRequest)}>
          {FREEZE_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={mutation.isPending}>
          凍結する
        </button>
      </div>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
    </form>
  );
}
