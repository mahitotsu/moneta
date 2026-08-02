import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CommandAcceptedResponse } from "../api/types";

interface Props {
  accountId: string;
  icon: ReactNode;
  title: string;
  description: string;
  submitLabel: string;
  confirmMessage?: string;
  variant?: "default" | "danger";
  action: (accountId: string) => Promise<CommandAcceptedResponse>;
}

/** Unfreeze/Closeで共有(ボディなしPOST、docs/adr/0007参照)。設定画面の1行として表示する。 */
export function SimpleActionButton({
  accountId,
  icon,
  title,
  description,
  submitLabel,
  confirmMessage,
  variant = "default",
  action,
}: Props) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => action(accountId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
  });

  return (
    <div className="settings-item">
      <div className="settings-item-header">
        <span className={`settings-item-icon${variant === "danger" ? " settings-item-icon-danger" : ""}`}>
          {icon}
        </span>
        <div>
          <p className="settings-item-title">{title}</p>
          <p className="settings-item-desc">{description}</p>
        </div>
      </div>
      <button
        type="button"
        className={`settings-item-action${variant === "danger" ? " settings-item-action-danger" : ""}`}
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
