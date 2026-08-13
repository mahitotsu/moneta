// docs/adr/0016: auth.tsのうちAWS SDKを呼ばない部分(IDトークンのclaim読み取り・期限判定・
// localStorageの読み書き)をunit testする。signUp/signIn/getIdTokenのリフレッシュ経路は
// Cognitoへの実ネットワーク呼び出しを要するため対象外——account-serviceのDynamoDB依存部分を
// unit testしない(CLAUDE.md)のと同じ方針。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSession, getIdToken, signOut } from "./auth";

/** テスト用の最小限のJWTを組み立てる(署名検証はauth.ts側でしないため、ダミーの
 * signature文字列で十分)。base64url(JSONペイロード)の1セグメントだけが実際に読まれる。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "none" })}.${base64url(payload)}.signature`;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("getCurrentSession", () => {
  it("保存されたIDトークンが無ければnull", () => {
    expect(getCurrentSession()).toBeNull();
  });

  it("保存されたIDトークンのsub/cognito:usernameを返す", () => {
    localStorage.setItem(
      "moneta.auth.idToken",
      fakeJwt({ sub: "abc-123", "cognito:username": "taro-yamada", exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    expect(getCurrentSession()).toEqual({ sub: "abc-123", username: "taro-yamada" });
  });

  it("subまたはcognito:usernameが欠けているトークンはnull", () => {
    localStorage.setItem("moneta.auth.idToken", fakeJwt({ sub: "abc-123" }));
    expect(getCurrentSession()).toBeNull();
  });

  it("壊れた(JWTの形をしていない)トークンはnull", () => {
    localStorage.setItem("moneta.auth.idToken", "not-a-jwt");
    expect(getCurrentSession()).toBeNull();
  });
});

describe("signOut", () => {
  it("保存済みトークンを全て消し、以後getCurrentSessionはnullを返す", () => {
    localStorage.setItem(
      "moneta.auth.idToken",
      fakeJwt({ sub: "abc-123", "cognito:username": "taro-yamada", exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    localStorage.setItem("moneta.auth.accessToken", "access");
    localStorage.setItem("moneta.auth.refreshToken", "refresh");

    signOut();

    expect(getCurrentSession()).toBeNull();
    expect(localStorage.getItem("moneta.auth.accessToken")).toBeNull();
    expect(localStorage.getItem("moneta.auth.refreshToken")).toBeNull();
  });
});

describe("getIdToken", () => {
  it("サインインしていなければnull", async () => {
    expect(await getIdToken()).toBeNull();
  });

  it("十分な有効期限が残っていれば、Cognitoへ問い合わせずそのまま返す", async () => {
    const token = fakeJwt({ sub: "abc-123", "cognito:username": "taro-yamada", exp: Math.floor(Date.now() / 1000) + 3600 });
    localStorage.setItem("moneta.auth.idToken", token);
    localStorage.setItem("moneta.auth.accessToken", "access");

    expect(await getIdToken()).toBe(token);
  });
});
