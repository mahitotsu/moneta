import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CommandAcceptedResponse } from "../api/types";

interface Props {
  accountId: string;
  title: string;
  submitLabel: string;
  confirmMessage?: string;
  action: (accountId: string) => Promise<CommandAcceptedResponse>;
}

/** Unfreeze/Closeで共有(ボディなしPOST、docs/adr/0007参照)。 */
export function SimpleActionButton({ accountId, title, submitLabel, confirmMessage, action }: Props) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => action(accountId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
  });

  return (
    <div className="panel">
      <h2>{title}</h2>
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => {
          if (confirmMessage && !window.confirm(confirmMessage)) return;
          mutation.mutate();
        }}
      >
        {submitLabel}
      </button>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
    </div>
  );
}
