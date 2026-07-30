-- Aurora DSQLでは各DDL文を個別のトランザクションで実行する必要がある
-- (docs/adr/0002参照)。1ファイルにまとめているが、適用時は1文ずつ実行すること。

CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    balance NUMERIC NOT NULL,
    frozen_reason TEXT,
    frozen_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ
);

CREATE TABLE account_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ASYNC account_events_account_id_idx ON account_events (account_id);

CREATE TABLE processed_messages (
    message_id TEXT PRIMARY KEY,
    account_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
