import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { openAccount } from "../api/client";

export function OpenAccountForm({ onOpened }: { onOpened: (accountId: string) => void }) {
  const [initialBalance, setInitialBalance] = useState("0.00");
  const mutation = useMutation({
    mutationFn: (balance: string) => openAccount(balance),
  });

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(initialBalance, {
          onSuccess: (res) => onOpened(res.accountId),
        });
      }}
    >
      <h2>口座を新規開設</h2>
      <label className="field-label" htmlFor="initial-balance">
        初期残高
      </label>
      <div className="field-row">
        <input
          id="initial-balance"
          value={initialBalance}
          onChange={(e) => setInitialBalance(e.target.value)}
          inputMode="decimal"
        />
        <button type="submit" disabled={mutation.isPending}>
          開設
        </button>
      </div>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
    </form>
  );
}
