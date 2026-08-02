import { useState } from "react";
import { Bank } from "./icons";

/** ダミーサインイン(何も検証しない、名前を名乗るだけ、docs/adr/0009)。
 * 見た目は実際のネットバンキングのログイン画面(中央のロゴ+単一フォーム+規約的な注記)に
 * 寄せるが、注記でダミーであることを明示する点は変えない([[0007-web-ui-stack-and-hosting]]
 * の「認証UIなし」を撤回しない、docs/adr/0009決定2)。 */
export function SignInForm({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const [name, setName] = useState("");

  return (
    <div className="bank-body signin-body">
      <div className="signin-brand">
        <span className="appbar-mark signin-mark">
          <Bank />
        </span>
        <h1 className="signin-title">モネタ銀行</h1>
        <p className="subtitle">個人向けネットバンキング</p>
      </div>

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== "") onSignedIn(name.trim());
        }}
      >
        <label className="field-label" htmlFor="signin-name">
          お客様のお名前
        </label>
        <input
          id="signin-name"
          className="field-input-wide"
          placeholder="山田 太郎"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="button-block" disabled={name.trim() === ""}>
          ログイン
        </button>
      </form>

      <p className="disclaimer">
        これはPoCのダミーサインインで、実際の認証は行われません。入力した名前がそのまま
        「顧客名」として扱われ、口座一覧はこの名前ごとにこのブラウザのlocalStorageにのみ
        保存されます(他の端末・ブラウザとは共有されません)。
      </p>
    </div>
  );
}
