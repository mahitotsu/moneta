/** 支店の固定一覧(docs/adr/0015決定4)。
 * `crates/query-service/src/account_number.rs`の`BRANCHES`と内容を一致させる——`TransferKind`/
 * `TransferState`のラベルマップ(`api/types.ts`)と同じ「固定の値集合をクライアント側にも
 * 複製する」既存パターン。振込(他行あて以外)の宛先入力で、支店を選ばせる`<select>`の
 * 選択肢に使う。 */
export interface BranchOption {
  code: string;
  name: string;
}

export const BRANCH_OPTIONS: BranchOption[] = [
  { code: "001", name: "本店" },
  { code: "002", name: "東京支店" },
  { code: "003", name: "大阪支店" },
  { code: "009", name: "インターネット支店" },
];

export const BRANCH_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  BRANCH_OPTIONS.map((b) => [b.code, b.name]),
);
