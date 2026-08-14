// Amazon Cognitoによる実認証(docs/adr/0016)。web-ui/src/auth.tsのsignUp/signIn(同じ
// `@aws-sdk/client-cognito-identity-provider`、`USER_PASSWORD_AUTH`フロー)と同じSDK呼び出し形を
// Node/Playwright向けに薄く再現する——api-e2e/support/auth.tsの同型コピー(独立パッケージの
// 方針、stackOutputs.tsと同じ理由)だが、こちらはidToken/subだけでなくaccessToken/refreshToken
// も返す。ブラウザ側のauth.tsはこの3つ全てをlocalStorageに保持するため、support/session.tsが
// 実ブラウザに「サインイン済み」を再現するには3つとも要る。
import {
  CognitoIdentityProviderClient,
  DeleteUserCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { REGION } from "./stackOutputs";

let cachedClient: CognitoIdentityProviderClient | undefined;
function client(): CognitoIdentityProviderClient {
  if (!cachedClient) cachedClient = new CognitoIdentityProviderClient({ region: REGION });
  return cachedClient;
}

// signUpAndSignIn()が作った使い捨てユーザーのaccessTokenを溜めておき、support/fixtures.tsの
// worker終了時フックからcleanupSignedUpUsers()で一括削除する。これが無いと、npm testを回す
// たびにUser Poolへユーザーが際限なく積み上がる(2026-08-14発覚: 実際に60件超が溜まっていた)。
const accessTokensPendingCleanup: string[] = [];

// web-ui/src/auth.tsのdecodeJwtPayloadと同じ役割(署名検証はしない——サーバー側の
// CognitoUserPoolsAuthorizerが検証する側であり、ここではsubクレームを読むためだけに使う)。
function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(base64, "base64").toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

/** support/seed.tsが、開設した口座のownerId(=idTokenのsub)をsupport/testDataCleanup.tsへ
 * 追跡登録するために使う。不正な形式のトークンならundefinedを返す(例外を投げない——呼び出し側は
 * 「追跡できなければ諦める」というベストエフォートの扱い、api-e2e/support/auth.tsの同名関数と
 * 同じ考え方)。 */
export function subFromIdToken(idToken: string): string | undefined {
  try {
    const sub = decodeJwtPayload(idToken).sub;
    return typeof sub === "string" ? sub : undefined;
  } catch {
    return undefined;
  }
}

export interface TestIdentity {
  username: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Cognitoのsub。CustomerAccountsTableのownerIdになる値(docs/adr/0016決定3・4)。 */
  sub: string;
}

// 毎回、新規サインアップ+サインインした使い捨てのCognitoユーザーを1つ作る
// (api-e2e/support/auth.tsのsignUpAndSignInと同じ「テストごとに新規、共有フィクスチャなし」の
// 哲学)。確認コード入力は不要——PreSignUpトリガーが常にautoConfirmUser: trueを返すため、
// SignUp直後に即座にInitiateAuthできる。
export async function signUpAndSignIn(clientId: string): Promise<TestIdentity> {
  const username = `ui-e2e-${crypto.randomUUID()}`;
  const password = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await client().send(new SignUpCommand({ ClientId: clientId, Username: username, Password: password }));

  const result = await client().send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const auth = result.AuthenticationResult;
  if (!auth?.IdToken || !auth.AccessToken || !auth.RefreshToken) {
    throw new Error(`signUpAndSignIn(${username}): InitiateAuth did not return a full token set`);
  }
  accessTokensPendingCleanup.push(auth.AccessToken);

  const claims = decodeJwtPayload(auth.IdToken);
  const sub = claims.sub;
  if (typeof sub !== "string") {
    throw new Error(`signUpAndSignIn(${username}): IdToken payload has no string "sub" claim`);
  }
  return { username, idToken: auth.IdToken, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken, sub };
}

/** auth.spec.tsのように実際のサインイン画面(web-ui/src/auth.ts)を通してサインアップした
 * ユーザーは、このモジュールのsignUpAndSignIn()を経由しないためcleanupSignedUpUsers()の
 * 対象に自動では乗らない。ブラウザのlocalStorage(`moneta.auth.accessToken`)から直接取り出した
 * accessTokenを渡して、同じクリーンアップ待ち行列に加えるためのヘルパー。 */
export function registerAccessTokenForCleanup(accessToken: string): void {
  accessTokensPendingCleanup.push(accessToken);
}

/** support/fixtures.tsのworker-scopedフィクスチャから呼ぶ、ワーカー単位の一括クリーンアップ。
 * セルフサービスのDeleteUser(有効なaccessTokenさえあれば呼べる、追加のIAM権限は不要)で
 * 1件ずつ削除する。1件の削除失敗が他の削除やテスト結果そのものを巻き込まないよう、失敗は
 * ログに残すのみで例外を投げない(api-e2e/support/auth.tsの同名関数と同じ考え方)。 */
export async function cleanupSignedUpUsers(): Promise<void> {
  const tokens = accessTokensPendingCleanup.splice(0, accessTokensPendingCleanup.length);
  await Promise.all(
    tokens.map(async (accessToken) => {
      try {
        await client().send(new DeleteUserCommand({ AccessToken: accessToken }));
      } catch (err) {
        console.warn(`cleanupSignedUpUsers: failed to delete a test user: ${String(err)}`);
      }
    }),
  );
}
