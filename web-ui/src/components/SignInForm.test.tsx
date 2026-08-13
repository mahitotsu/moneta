// docs/adr/0016: ダミーサインイン(customerSession.ts)がCognito実認証(auth.ts)に
// 置き換わったことを検証する——ログイン/新規登録の2モード切り替え、成功時にauth.tsの
// 戻り値(AuthSession)がそのままonSignedInへ渡ること、失敗時にAWS/Cognitoの内部例外名を
// 出さない業務文言になることを確認する。このコンポーネント初のテスト。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../queryClient";
import { SignInForm } from "./SignInForm";
import type { AuthSession } from "../auth";

vi.mock("../auth", () => ({
  signUp: vi.fn(),
  signIn: vi.fn(),
}));

const { signUp, signIn } = await import("../auth");
const signUpMock = vi.mocked(signUp);
const signInMock = vi.mocked(signIn);

afterEach(cleanup);

function renderForm(onSignedIn: (session: AuthSession) => void) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <SignInForm onSignedIn={onSignedIn} />
    </QueryClientProvider>,
  );
}

function fillCredentials(username: string, password: string) {
  fireEvent.change(screen.getByLabelText("ユーザー名"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: password } });
}

describe("ログイン(既定モード)", () => {
  it("成功するとauth.signInの戻り値をそのままonSignedInへ渡す", async () => {
    const session: AuthSession = { sub: "abc-123", username: "taro-yamada" };
    signInMock.mockResolvedValue(session);
    const onSignedIn = vi.fn();

    renderForm(onSignedIn);
    fillCredentials("taro-yamada", "password123");
    fireEvent.click(screen.getByText("ログインする"));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledWith(session);
    });
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("ユーザー名またはパスワードが誤っていると、内部例外名を出さない業務文言を表示する", async () => {
    const err = new Error("Incorrect username or password.");
    err.name = "NotAuthorizedException";
    signInMock.mockRejectedValue(err);

    renderForm(vi.fn());
    fillCredentials("taro-yamada", "wrong-password");
    fireEvent.click(screen.getByText("ログインする"));

    await waitFor(() => {
      expect(screen.getByText("ユーザー名またはパスワードが正しくありません。")).toBeTruthy();
    });
    expect(screen.queryByText(/NotAuthorizedException/)).toBeNull();
  });
});

describe("新規登録モード", () => {
  it("タブを切り替えて送信すると、signUpの後にsignInが呼ばれる", async () => {
    signUpMock.mockResolvedValue(undefined);
    const session: AuthSession = { sub: "def-456", username: "hanako" };
    signInMock.mockResolvedValue(session);
    const onSignedIn = vi.fn();

    renderForm(onSignedIn);
    fireEvent.click(screen.getByText("新規登録"));
    fillCredentials("hanako", "password123");
    fireEvent.click(screen.getByText("登録してはじめる"));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledWith(session);
    });
    expect(signUpMock).toHaveBeenCalledWith("hanako", "password123");
    expect(signInMock).toHaveBeenCalledWith("hanako", "password123");
  });

  it("既に使われているユーザー名は、内部例外名を出さない業務文言を表示する", async () => {
    const err = new Error("User already exists");
    err.name = "UsernameExistsException";
    signUpMock.mockRejectedValue(err);

    renderForm(vi.fn());
    fireEvent.click(screen.getByText("新規登録"));
    fillCredentials("taro-yamada", "password123");
    fireEvent.click(screen.getByText("登録してはじめる"));

    await waitFor(() => {
      expect(screen.getByText("そのユーザー名は既に使われています。別の名前をお試しください。")).toBeTruthy();
    });
    expect(screen.queryByText(/UsernameExistsException/)).toBeNull();
  });
});

describe("送信ボタンの活性/非活性", () => {
  it("パスワードが8文字未満の間は送信できない", () => {
    renderForm(vi.fn());
    fillCredentials("taro-yamada", "short");
    expect((screen.getByText("ログインする") as HTMLButtonElement).disabled).toBe(true);
  });
});
