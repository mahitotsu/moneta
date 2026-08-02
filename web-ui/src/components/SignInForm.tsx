import { useState } from "react";

/** ダミーサインイン(何も検証しない、名前を名乗るだけ、docs/adr/0009)。 */
export function SignInForm({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const [name, setName] = useState("");

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== "") onSignedIn(name.trim());
      }}
    >
      <h2>サインイン</h2>
      <p className="subtitle">
        認証機構はありません(ダミー)。名前を入力するとその名前の顧客として口座一覧を表示します。
      </p>
      <div className="field-row">
        <input placeholder="お名前" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={name.trim() === ""}>
          サインイン
        </button>
      </div>
    </form>
  );
}
