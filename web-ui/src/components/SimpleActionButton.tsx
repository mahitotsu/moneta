import type { ReactNode } from "react";
import type { CommandAcceptedResponse } from "../api/types";
import { useSettlingMutation } from "../hooks/useSettlingMutation";

interface Props {
  accountId: string;
  currentStatus: string;
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
  currentStatus,
  icon,
  title,
  description,
  submitLabel,
  confirmMessage,
  variant = "default",
  action,
}: Props) {
  const { mutate, isBusy, isError, error } = useSettlingMutation(
    () => action(accountId),
    ["account", accountId],
    currentStatus,
  );

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
        disabled={isBusy}
        onClick={() => {
          if (confirmMessage && !window.confirm(confirmMessage)) return;
          mutate();
        }}
      >
        {isBusy ? "処理中..." : submitLabel}
      </button>
      {isError && <p className="status-line error">{(error as Error).message}</p>}
    </div>
  );
}
