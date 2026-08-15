import { useSyncExternalStore } from "react";

// 残高マスクの表示/非表示は、口座一覧(AccountListScreen)と口座詳細(AccountView)の
// どちらの目アイコンから切り替えても同じ状態になるよう、画面ローカルなuseStateではなく
// モジュール単位で共有する。旧実装は口座詳細だけがローカルstateでマスクを持っており、
// 一覧画面には無かった上、画面をまたぐと(あるいは詳細を開き直すだけでも)表示に戻って
// いた——「一覧では丸見え」という指摘の直接の原因。
//
// 初期値は「隠す」を既定にする(プライバシーバイデフォルト)。サインイン直後に必ず経由する
// 一覧画面が一番人目に触れやすいため、旧実装の「まず見せてから隠す」という前提を逆にする。
// sessionStorageに保存し、同一タブでのリロードでは選択を維持しつつ、新しいタブ/ブラウザ
// セッションでは既定の「隠す」に戻す(残高そのものは保存しないので漏洩の余地はない)。
const STORAGE_KEY = "moneta.balanceHidden";

function readStored(): boolean | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored === null ? null : stored === "true";
  } catch {
    // プライベートブラウジング等でsessionStorageが使えない場合も、既定値(隠す)にすれば安全側。
    return null;
  }
}

let hidden = readStored() ?? true;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  return hidden;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 残高マスクの状態を直接設定する。サインアウト時(CustomerFlow)に、共有端末を想定して
 * 次にサインインする利用者へ前の利用者の選択を持ち越さず既定値に戻すために使う。 */
export function setBalanceHidden(next: boolean): void {
  if (hidden === next) return;
  hidden = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // 保存できなくても、開いている画面間でのメモリ上の状態共有自体は成立するので無視してよい。
  }
  listeners.forEach((listener) => listener());
}

/** 口座一覧・口座詳細で共有する残高マスクの状態。戻り値は[隠しているか, 切り替え関数]。 */
export function useBalanceHidden(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot);
  return [value, () => setBalanceHidden(!hidden)];
}
