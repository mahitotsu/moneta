-- Aurora DSQLでは各DDL文を個別のトランザクションで実行する必要がある(docs/adr/0002参照)。
-- 1ファイルにまとめているが、適用時は1文ずつ実行すること。
--
-- べき等性: account-schema-migrator(CDK Custom Resource、docs/adr/0005)がデプロイのたびに
-- このファイルをそのまま再実行する。新しい文を足すときは必ず IF NOT EXISTS を付けること
-- (列を追加する場合は、新規デプロイ用にCREATE TABLE本体にも列を足しつつ、既存デプロイ用に
-- 別途 ALTER TABLE ... ADD COLUMN IF NOT EXISTS も足す——両方が要る)。

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    balance NUMERIC NOT NULL,
    frozen_reason TEXT,
    frozen_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS account_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULLの間はEventBridgeへ未発行(アウトボックスのポーリング対象)。
    -- account-outbox-relayがPutEvents成功後にここへタイムスタンプを書く(docs/adr/0004)。
    published_at TIMESTAMPTZ
);

-- account_eventsが先に(published_at列なしで)作られていた既存デプロイ向け。
ALTER TABLE account_events ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- CREATE INDEX ASYNCがIF NOT EXISTSをサポートするか公式ドキュメントで確認が取れなかったため
-- (CREATE TABLE/ALTER TABLE ADD COLUMNは確認済み)、あえて付けていない。再実行時の重複エラーは
-- account-schema-migrator側で「既に存在する」系のエラーとして捕捉・無視する。
CREATE INDEX ASYNC account_events_account_id_idx ON account_events (account_id);
CREATE INDEX ASYNC account_events_published_at_idx ON account_events (published_at, created_at);

CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    account_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
