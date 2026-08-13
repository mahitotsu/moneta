import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bank } from "./icons";
import { signIn, signUp, type AuthSession } from "../auth";

type Mode = "signin" | "signup";

// 画面にはAWS/Cognitoの内部例外名を一切出さず、業務的な文言だけを見せる(過去の指摘事項、
// web-ui全体の方針)。生のエラー内容は開発者向けにconsole.errorへ残す。
function friendlyAuthErrorMessage(mode: Mode, err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  switch (name) {
    case "UsernameExistsException":
      return "そのユーザー名は既に使われています。別の名前をお試しください。";
    case "InvalidPasswordException":
      return "パスワードは8文字以上で入力してください。";
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return "ユーザー名またはパスワードが正しくありません。";
    case "InvalidParameterException":
      return "入力内容をご確認ください。";
    default:
      return mode === "signup"
        ? "新規登録に失敗しました。時間をおいて再度お試しください。"
        : "ログインに失敗しました。時間をおいて再度お試しください。";
  }
}

/** Amazon Cognitoによる実認証(docs/adr/0016)。見た目は実際のネットバンキングのログイン
 * 画面(中央のロゴ+単一フォーム)に寄せつつ、新規登録/ログインをタブで切り替える。
 * PreSignUpトリガーが自動確認するため、サインアップ後は確認コード入力なしですぐに
 * ログインできる(auth.tsのsignUpが内部でsignInまで行う)。 */
export function SignInForm({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "signup") {
        await signUp(username, password);
      }
      return signIn(username, password);
    },
    onSuccess: (session) => onSignedIn(session),
  });

  const canSubmit = username.trim() !== "" && password.length >= 8 && !mutation.isPending;

  return (
    <div className="bank-body signin-body">
      <div className="signin-brand">
        <span className="appbar-mark signin-mark">
          <Bank />
        </span>
        <h1 className="signin-title">モネタ銀行</h1>
        <p className="subtitle">個人向けネットバンキング</p>
      </div>

      <nav className="bank-tabs">
        <button
          type="button"
          className={mode === "signin" ? "active" : "secondary"}
          onClick={() => {
            setMode("signin");
            mutation.reset();
          }}
        >
          ログイン
        </button>
        <button
          type="button"
          className={mode === "signup" ? "active" : "secondary"}
          onClick={() => {
            setMode("signup");
            mutation.reset();
          }}
        >
          新規登録
        </button>
      </nav>

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="field-label" htmlFor="signin-username">
          ユーザー名
        </label>
        <input
          id="signin-username"
          className="field-input-wide"
          placeholder="taro-yamada"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <label className="field-label" htmlFor="signin-password">
          パスワード
        </label>
        <input
          id="signin-password"
          className="field-input-wide"
          type="password"
          placeholder="8文字以上"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        <button type="submit" className="button-block" disabled={!canSubmit}>
          {mode === "signup" ? "登録してはじめる" : "ログインする"}
        </button>
        {mutation.isError && (
          <p className="status-line error">{friendlyAuthErrorMessage(mode, mutation.error)}</p>
        )}
      </form>

      <p className="disclaimer">
        {mode === "signup"
          ? "入力したユーザー名・パスワードでアカウントを作成します(メールアドレスの確認は不要です)。"
          : "実在の銀行ではありません。この画面は技術検証用のPoCです。"}
      </p>
    </div>
  );
}
