// Amazon Cognitoによる実認証(docs/adr/0016)。web-ui/src/auth.tsのsignUp/signIn(同じ
// `@aws-sdk/client-cognito-identity-provider`、`USER_PASSWORD_AUTH`フロー、docs/adr/0016決定1)
// と同じSDK呼び出し形をNode/Jest向けに薄く再現する——ブラウザのlocalStorage永続化やトークン
// リフレッシュは、テスト実行が短命(1テストの寿命を超えて生き続ける必要がない)なため持たない。
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { REGION } from "./stackOutputs";

let cachedClient: CognitoIdentityProviderClient | undefined;
function client(): CognitoIdentityProviderClient {
  if (!cachedClient) cachedClient = new CognitoIdentityProviderClient({ region: REGION });
  return cachedClient;
}

// IDトークン(JWT)のペイロードをbase64url decode+JSON.parseするだけの最小限のヘルパー
// (web-ui/src/auth.tsのdecodeJwtPayloadと同じ役割、Node向けにBufferで書き直したもの)。
// 署名検証はしない——サーバー側(API GatewayのCognitoUserPoolsAuthorizer)が検証する側であり、
// ここではsubクレームを取り出すためだけに中身を読む。
function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(base64, "base64").toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

export interface TestIdentity {
  /** `Authorization: Bearer ${idToken}`としてそのまま使う。 */
  idToken: string;
  /** Cognitoのsub。account-serviceのowner_id/CustomerAccountsTableのownerIdになる値
   * (docs/adr/0016決定3・4)——テスト側でアサーションに使う場合はこれと比較する。 */
  sub: string;
}

// 毎回、新規サインアップ+サインインした使い捨てのCognitoユーザーを1つ作る。口座IDに
// crypto.randomUUID()を使うのと同じ「テストごとに新規、共有フィクスチャなし」の哲学
// (support/testAccount.tsのopenFreshAccount)をID基盤にも適用したもの。パスワードは
// 8文字以上であれば複雑性要件が一切ない(docs/adr/0016決定1)ので、UUIDの断片で足りる。
// 確認コード入力は不要——PreSignUpトリガーが常にautoConfirmUser: trueを返すため、
// SignUp直後に即座にInitiateAuthできる。
export async function signUpAndSignIn(clientId: string): Promise<TestIdentity> {
  const username = `e2e-${crypto.randomUUID()}`;
  const password = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await client().send(new SignUpCommand({ ClientId: clientId, Username: username, Password: password }));

  const result = await client().send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const idToken = result.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new Error(`signUpAndSignIn(${username}): InitiateAuth did not return an IdToken`);
  }

  const claims = decodeJwtPayload(idToken);
  const sub = claims.sub;
  if (typeof sub !== "string") {
    throw new Error(`signUpAndSignIn(${username}): IdToken payload has no string "sub" claim`);
  }
  return { idToken, sub };
}
