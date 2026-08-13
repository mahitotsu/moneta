// 顧客が開始した送金の一覧を、web-uiのlocalStorageだけで表現する(docs/adr/0012決定6)。
// 口座一覧(かつてのcustomerSession.ts)は認証の導入(docs/adr/0016)でサーバー側の
// CustomerAccountsTableに置き換わったが、送金履歴は今回のセキュリティ上の懸念(口座の
// 閲覧・操作)の対象外でありスコープに含めていない——バックエンドに対応する概念を追加せず、
// ブラウザ・端末をまたいでは共有されないという割り切りを引き続き受け入れる。

import type { TransferKind } from "./api/types";

const transfersKey = (customerName: string) => `moneta.transfers.${customerName}`;

export interface CustomerTransfer {
  transferId: string;
  /** フォーム送信時点でのUI上の意図(振替/振込フォームのどちらから送信したか)。組戻しは
   * TransferDetailScreenが新しいtransferIdを採番する際に"recall"で記録する。表示は常に
   * サーバー側のTransferStatusView.kindを優先し、これは一覧をまだ照会できていない間の
   * つなぎとしてのみ使う。 */
  kind: TransferKind;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  /** フォーム送信時のクライアント側タイムスタンプ(ISO)。一覧の並び順の表示専用——
   * 状態そのものは常にTransferStatusView(サーバー側、TransferQueryApi)を正とする。 */
  startedAt: string;
}

/** 新しい順(先頭が最新)。 */
export function getTransfersFor(customerName: string): CustomerTransfer[] {
  const raw = localStorage.getItem(transfersKey(customerName));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CustomerTransfer[];
  } catch {
    return [];
  }
}

export function addTransferFor(customerName: string, transfer: CustomerTransfer): void {
  const existing = getTransfersFor(customerName);
  if (existing.some((t) => t.transferId === transfer.transferId)) return;
  localStorage.setItem(transfersKey(customerName), JSON.stringify([transfer, ...existing]));
}
