import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CommandAcceptedResponse } from "../api/types";

interface Props {
  accountId: string;
  title: string;
  submitLabel: string;
  action: (accountId: string, amount: string) => Promise<CommandAcceptedResponse>;
}

/** Deposit/Withdrawで共有(金額入力+送信という同一形状のため、docs/adr/0007参照)。 */
export function AmountOperationForm({ accountId, title, submitLabel, action }: Props) {
  const [amount, setAmount] = useState("0.00");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: string) => action(accountId, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
  });

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(amount);
      }}
    >
      <h2>{title}</h2>
      <div className="field-row">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button type="submit" disabled={mutation.isPending}>
          {submitLabel}
        </button>
      </div>
      {mutation.isError && <p className="status-line error">{(mutation.error as Error).message}</p>}
    </form>
  );
}
