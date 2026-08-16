#!/usr/bin/env node
// デプロイ直後のスタックには、口座もサインイン先も何もない——e2eテスト用の使い捨てデータ
// (docs/adr/0016以降、api-e2e/ui-e2eのteardownで都度片付く)とは別に、UIの動作確認や記事の
// デモに使える「消えない」データが要る、という2026-08-14の議論を受けて新設。
//
// 明確に区別できるCognitoユーザー名(`demo-customer`・`demo-customer-2`、DEMO_USERNAMESで定義)
// で口座を開設・振替・振込まで実行し、残高・取引履歴が入った状態を再現する。この命名規約が、
// clean-data.tsの一括削除がデモデータを巻き込まないための唯一の目印になる
// (支店・口座番号を検索して振込先を選ぶのと同じ理由で、Cognitoのsubは再デプロイのたびに
// 変わるためユーザー名の方を固定の目印にする)。
//
// べき等: 既にdemo-customerが2口座以上持っていれば「既に投入済み」とみなし何もしない
// (毎回実行しても口座が増え続けない)。事故で中途半端な状態になった場合の自動復旧は
// 持たない(PoC規模の割り切り——手動でCognito側のユーザーを削除してから再実行すれば
// ゼロからやり直せる)。
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  SignUpCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { fetchStackOutputs, REGION, StackOutputs } from "../support/stackOutputs";

// clean-data.tsのDEMO_OWNER_USERNAMESと対応させる唯一の場所(あちらはこの配列そのものを
// importして使う)。
export const DEMO_USERNAMES = ["demo-customer", "demo-customer-2"] as const;
// Cognitoのパスワードポリシーは8文字以上・複雑性要件なし(docs/adr/0016決定1)。デモ用の
// 固定パスワードであり秘匿情報ではない(README.mdに明記して開発者が実際にログインし確認できる
// ようにする)。
export const DEMO_PASSWORD = "MonetaDemo123";

interface Identity {
  username: string;
  idToken: string;
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });

async function signIn(clientId: string, username: string): Promise<string | undefined> {
  try {
    const result = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: username, PASSWORD: DEMO_PASSWORD },
      }),
    );
    return result.AuthenticationResult?.IdToken;
  } catch (err) {
    if (err instanceof UserNotFoundException || err instanceof NotAuthorizedException) return undefined;
    throw err;
  }
}

async function ensureDemoUser(clientId: string, username: string): Promise<Identity> {
  const existing = await signIn(clientId, username);
  if (existing) {
    console.log(`[cognito] ${username}: already exists, signed in`);
    return { username, idToken: existing };
  }

  try {
    await cognito.send(new SignUpCommand({ ClientId: clientId, Username: username, Password: DEMO_PASSWORD }));
    console.log(`[cognito] ${username}: signed up (PreSignUpトリガーが自動確認、docs/adr/0016決定1)`);
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;
    // サインインが失敗したのにSignUpが「既に存在する」と言う=パスワードポリシー変更等で
    // 固定パスワードが合わなくなっている、という矛盾した状態。手動介入が必要。
    throw new Error(
      `${username}: sign-in failed but the user already exists in Cognito -- DEMO_PASSWORD may be stale. ` +
        `Delete the user manually and re-run, or fix the password.`,
    );
  }

  const idToken = await signIn(clientId, username);
  if (!idToken) throw new Error(`${username}: signed up but sign-in still failed`);
  return { username, idToken };
}

interface AccountView {
  status: "active" | "frozen" | "closed";
  balance: string;
}
interface MyAccount {
  accountId: string;
}
interface AccountNumberLookup {
  accountId: string;
  accountNumber: string;
  branchCode: string;
}
interface TransferStatusView {
  transferId: string;
  state: string;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, description: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function authHeaders(idToken: string): Record<string, string> {
  return { Authorization: `Bearer ${idToken}` };
}

async function openAccount(outputs: StackOutputs, idToken: string, initialBalance: string): Promise<string> {
  const accountId = crypto.randomUUID();
  const response = await fetch(`${outputs.commandApiUrl}/accounts/${accountId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), ...authHeaders(idToken) },
    body: JSON.stringify({ initial_balance: initialBalance }),
  });
  if (response.status !== 202) throw new Error(`openAccount(${accountId}) unexpected status ${response.status}`);
  await waitFor(async () => {
    const r = await fetch(`${outputs.queryApiUrl}/accounts/${accountId}`, { headers: authHeaders(idToken) });
    if (r.status !== 200) return undefined;
    const view = (await r.json()) as AccountView;
    return view.status === "active" ? true : undefined;
  }, `account ${accountId} to become active`);
  return accountId;
}

async function deposit(outputs: StackOutputs, accountId: string, amount: string): Promise<void> {
  const response = await fetch(`${outputs.commandApiUrl}/accounts/${accountId}/deposits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ amount }),
  });
  if (response.status !== 202) throw new Error(`deposit(${accountId}, ${amount}) unexpected status ${response.status}`);
}

async function getBalance(outputs: StackOutputs, idToken: string, accountId: string): Promise<string> {
  return waitFor(async () => {
    const r = await fetch(`${outputs.queryApiUrl}/accounts/${accountId}`, { headers: authHeaders(idToken) });
    if (r.status !== 200) return undefined;
    return ((await r.json()) as AccountView).balance;
  }, `account ${accountId} balance to be readable`);
}

async function getMyAccountCount(outputs: StackOutputs, idToken: string): Promise<number> {
  const r = await fetch(`${outputs.queryApiUrl}/customers/me/accounts`, { headers: authHeaders(idToken) });
  if (r.status !== 200) return 0;
  return ((await r.json()) as MyAccount[]).length;
}

async function resolveAccountNumber(
  outputs: StackOutputs,
  idToken: string,
  accountId: string,
): Promise<AccountNumberLookup> {
  return waitFor(async () => {
    const r = await fetch(`${outputs.accountNumberQueryApiUrl}/accounts/${accountId}/account-number`, {
      headers: authHeaders(idToken),
    });
    return r.status === 200 ? ((await r.json()) as AccountNumberLookup) : undefined;
  }, `account ${accountId} to get a friendly account number`);
}

async function startTransfer(
  outputs: StackOutputs,
  idToken: string,
  fromAccountId: string,
  toAccountId: string,
  amount: string,
): Promise<string> {
  const transferId = crypto.randomUUID();
  const response = await fetch(`${outputs.transferCommandApiUrl}/transfers/${transferId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(idToken) },
    body: JSON.stringify({ from_account_id: fromAccountId, to_account_id: toAccountId, amount }),
  });
  if (response.status !== 202) throw new Error(`startTransfer(${transferId}) unexpected status ${response.status}`);
  return transferId;
}

async function waitForTransferState(
  outputs: StackOutputs,
  idToken: string,
  transferId: string,
  expected: string[],
): Promise<void> {
  await waitFor(async () => {
    const r = await fetch(`${outputs.transferQueryApiUrl}/transfers/${transferId}`, { headers: authHeaders(idToken) });
    if (r.status !== 200) return undefined;
    const status = (await r.json()) as TransferStatusView;
    return expected.includes(status.state) ? true : undefined;
  }, `transfer ${transferId} to reach state in [${expected.join(", ")}]`, 60_000);
}

async function confirmTransfer(outputs: StackOutputs, idToken: string, transferId: string): Promise<void> {
  const response = await fetch(`${outputs.transferCommandApiUrl}/transfers/${transferId}/confirm`, {
    method: "POST",
    headers: authHeaders(idToken),
  });
  if (response.status !== 202) throw new Error(`confirmTransfer(${transferId}) unexpected status ${response.status}`);
}

async function main(): Promise<void> {
  const outputs = await fetchStackOutputs();
  console.log(`Seeding demo data into ${outputs.commandApiUrl}\n`);

  const customer = await ensureDemoUser(outputs.userPoolClientId, DEMO_USERNAMES[0]);
  const customer2 = await ensureDemoUser(outputs.userPoolClientId, DEMO_USERNAMES[1]);

  if ((await getMyAccountCount(outputs, customer.idToken)) >= 2) {
    console.log(`\n${customer.username} already has accounts -- assuming demo data is already seeded. Nothing to do.`);
    console.log(`(username: ${DEMO_USERNAMES.join(", ")} / password: ${DEMO_PASSWORD})`);
    return;
  }

  console.log(`\n[accounts] opening ${customer.username}'s two accounts...`);
  const account1 = await openAccount(outputs, customer.idToken, "0.00");
  const account2 = await openAccount(outputs, customer.idToken, "0.00");
  console.log(`[accounts] opening ${customer2.username}'s account...`);
  const account3 = await openAccount(outputs, customer2.idToken, "0.00");

  console.log(`[deposit] ${account1}: +300000.00 (external channel, docs/adr/0009決定1)`);
  await deposit(outputs, account1, "300000.00");
  await getBalance(outputs, customer.idToken, account1);

  console.log(`[furikae] ${account1} -> ${account2}: 50000.00`);
  const furikae = await startTransfer(outputs, customer.idToken, account1, account2, "50000.00");
  await waitForTransferState(outputs, customer.idToken, furikae, ["credited"]);

  console.log(`[furikomi] ${account1} -> ${account3} (${customer2.username}): 20000.00`);
  const toNumber = await resolveAccountNumber(outputs, customer.idToken, account3);
  const furikomi = await startTransfer(outputs, customer.idToken, account1, account3, "20000.00");
  await waitForTransferState(outputs, customer.idToken, furikomi, ["pending_confirmation"]);
  await confirmTransfer(outputs, customer.idToken, furikomi);
  await waitForTransferState(outputs, customer.idToken, furikomi, ["credited"]);

  // 逆方向の振込(customer2 -> customer)も1件作る(docs/adr/0020)。demo-customerだけで
  // サインインして、送金一覧・詳細の「送った(様へ)」「受け取った(様より)」両方の表示を
  // 見比べられるようにするため——上のfurikomiだけでは、demo-customerから見て常に送信側にしか
  // ならず、受信側の表示(相手方の名義・入金アイコン)を確認する手段がdemo-customer-2への
  // サインインを要求してしまっていた。
  console.log(`[furikomi] ${account3} -> ${account1} (${customer.username}, incoming for demo-customer): 5000.00`);
  const fromNumber = await resolveAccountNumber(outputs, customer2.idToken, account1);
  const furikomiIncoming = await startTransfer(outputs, customer2.idToken, account3, account1, "5000.00");
  await waitForTransferState(outputs, customer2.idToken, furikomiIncoming, ["pending_confirmation"]);
  await confirmTransfer(outputs, customer2.idToken, furikomiIncoming);
  await waitForTransferState(outputs, customer2.idToken, furikomiIncoming, ["credited"]);

  const balance1 = await getBalance(outputs, customer.idToken, account1);
  const balance2 = await getBalance(outputs, customer.idToken, account2);
  const balance3 = await getBalance(outputs, customer2.idToken, account3);

  console.log("\nDone. Sign in to the web-ui with:");
  for (const username of DEMO_USERNAMES) {
    console.log(`  username: ${username} / password: ${DEMO_PASSWORD}`);
  }
  console.log(`\n${customer.username}: ${account1} (${balance1}), ${account2} (${balance2})`);
  console.log(`${customer2.username}: ${account3} (${balance3}), branch ${toNumber.branchCode} no. ${toNumber.accountNumber}`);
  console.log(
    `${customer.username}'s account1 also has an incoming furikomi from ${customer2.username} ` +
      `(branch ${fromNumber.branchCode} no. ${fromNumber.accountNumber}), for comparing sent/received display.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
