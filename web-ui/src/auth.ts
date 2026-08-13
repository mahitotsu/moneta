// Amazon Cognitoによる実認証(docs/adr/0016)。customerSession.tsのダミーサインイン
// (パスワードなし、名前を名乗るだけ、localStorageのみ)を置き換える。`@aws-sdk/client-cognito-identity-provider`
// を薄く直接使う(Amplifyの重いSRPクライアントは新規依存に追加しない、ADR-0016決定1の
// トレードオフ)——`USER_PASSWORD_AUTH`フロー(TLSに保護される前提の単純化)。
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// このPoCのAWSセッションはap-northeast-1(東京)に固定している(infra/bin/infra.tsと同じ)。
const REGION = "ap-northeast-1";
const USER_POOL_CLIENT_ID = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;

const ID_TOKEN_KEY = "moneta.auth.idToken";
const ACCESS_TOKEN_KEY = "moneta.auth.accessToken";
const REFRESH_TOKEN_KEY = "moneta.auth.refreshToken";

export interface AuthSession {
  /** Cognitoのsub(安定した一意識別子)。account-serviceのowner_idになる(docs/adr/0016決定3)。 */
  sub: string;
  /** サインイン時に選んだユーザー名。表示専用(BrandAppBarの「○○様」等)。 */
  username: string;
}

let cachedClient: CognitoIdentityProviderClient | undefined;
function client(): CognitoIdentityProviderClient {
  if (!cachedClient) cachedClient = new CognitoIdentityProviderClient({ region: REGION });
  return cachedClient;
}

// IDトークン(JWT)のペイロードをbase64url decode+JSON.parseするだけの最小限のヘルパー。
// 署名検証はしない(サーバー側=API Gateway Cognito Authorizerが検証する。ここではブラウザ側の
// 表示・期限判定のためだけに中身を読む)——新規JWTライブラリは追加しない。
function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(base64)
      .split("")
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join(""),
  );
  return JSON.parse(json) as Record<string, unknown>;
}

function sessionFromIdToken(idToken: string): AuthSession | null {
  try {
    const claims = decodeJwtPayload(idToken);
    const sub = claims.sub;
    const username = claims["cognito:username"];
    if (typeof sub !== "string" || typeof username !== "string") return null;
    return { sub, username };
  } catch {
    return null;
  }
}

/** IDトークンの`exp`(秒)が既に過ぎている、またはあと60秒以内に切れるかどうか。 */
function isExpiredOrExpiringSoon(idToken: string): boolean {
  try {
    const claims = decodeJwtPayload(idToken);
    const exp = claims.exp;
    if (typeof exp !== "number") return true;
    return Date.now() >= exp * 1000 - 60_000;
  } catch {
    return true;
  }
}

function storeTokens(tokens: { idToken: string; accessToken: string; refreshToken?: string }): void {
  localStorage.setItem(ID_TOKEN_KEY, tokens.idToken);
  localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
  if (tokens.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

/** セルフサインアップ。確認コード入力は不要(PreSignUpトリガーが自動確認する、docs/adr/0016
 * 決定1)——成功したら即座にsignInできる状態になっている。 */
export async function signUp(username: string, password: string): Promise<void> {
  await client().send(
    new SignUpCommand({ ClientId: USER_POOL_CLIENT_ID, Username: username, Password: password }),
  );
}

export async function signIn(username: string, password: string): Promise<AuthSession> {
  const result = await client().send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: USER_POOL_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const auth = result.AuthenticationResult;
  if (!auth?.IdToken || !auth.AccessToken) {
    throw new Error("サインインに失敗しました。ユーザー名またはパスワードをご確認ください。");
  }
  storeTokens({ idToken: auth.IdToken, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken });
  const session = sessionFromIdToken(auth.IdToken);
  if (!session) throw new Error("サインインに失敗しました。時間をおいて再度お試しください。");
  return session;
}

export function signOut(): void {
  localStorage.removeItem(ID_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/** ページ読み込み時点でのセッション有無を同期的に判定する(customerSession.tsの
 * getSignedInCustomerと同じ契約——期限切れの検証はせず、保存済みIDトークンの中身を
 * そのまま返す。実際の有効性はAPI呼び出し時にgetIdTokenが検証・更新する)。 */
export function getCurrentSession(): AuthSession | null {
  const idToken = localStorage.getItem(ID_TOKEN_KEY);
  return idToken ? sessionFromIdToken(idToken) : null;
}

/** 有効な(必要なら自動更新した)IDトークンを返す。リフレッシュに失敗した場合は
 * サインアウト状態とみなしnullを返す——呼び出し側(api/client.ts)はこれをそのまま
 * Authorizationヘッダーに使う。 */
export async function getIdToken(): Promise<string | null> {
  const idToken = localStorage.getItem(ID_TOKEN_KEY);
  if (!idToken) return null;
  if (!isExpiredOrExpiringSoon(idToken)) return idToken;

  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    signOut();
    return null;
  }

  try {
    const result = await client().send(
      new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: USER_POOL_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    const auth = result.AuthenticationResult;
    if (!auth?.IdToken || !auth.AccessToken) {
      signOut();
      return null;
    }
    // REFRESH_TOKEN_AUTHはrefresh token自体を返さない(既存のものを使い続ける)。
    storeTokens({ idToken: auth.IdToken, accessToken: auth.AccessToken });
    return auth.IdToken;
  } catch {
    signOut();
    return null;
  }
}
