use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

/// CDK Custom Resource(docs/adr/0005)。デプロイのたびに冪等に呼ばれ、schema.sqlの適用・
/// account_service_appロールの作成・各Lambda実行ロールへのIAM GRANTを行う。かつては
/// `infra/scripts/apply-schema.sh`を手動実行する運用だったが、outbox relay用のロール追加を
/// スクリプト更新し忘れたまま実AWSにデプロイし、DSQLへの接続がaccess deniedになる不具合を
/// 実際に起こしたため、デプロイ自体に組み込んだ。
const SCHEMA_SQL: &str = include_str!("../../schema.sql");
const APP_DB_ROLE: &str = "account_service_app";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CustomResourceRequest {
    request_type: String,
    resource_properties: ResourceProperties,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ResourceProperties {
    cluster_endpoint: String,
    /// スキーマにアクセスするLambdaの実行ロールARN一覧(account-serviceの書き込みパス、
    /// account-outbox-relay)。Query Projector・照会APIはDSQLに触れないためここには含まない
    /// (docs/adr/0004のサービス境界)。
    #[serde(default)]
    lambda_role_arns: Vec<String>,
    // Trigger自体は使わない。値(schema.sqlの内容+ロールARN一覧のハッシュ)が変わるとCDKが
    // ResourceProperties変更とみなしUpdateイベントを発火させる、というためだけの存在。
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct CustomResourceResponse {
    physical_resource_id: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    run(service_fn(handler)).await
}

async fn handler(
    event: LambdaEvent<CustomResourceRequest>,
) -> Result<CustomResourceResponse, Error> {
    let request = event.payload;
    let physical_resource_id =
        format!("account-schema-migration-{}", request.resource_properties.cluster_endpoint);

    if request.request_type == "Delete" {
        // クラスタ自体がスタックの一部として削除されるため、SQL側で明示的な後始末は不要。
        return Ok(CustomResourceResponse { physical_resource_id });
    }

    // admin接続。aurora-dsql-sqlx-connectorはURLのユーザー名が"admin"だと
    // db_connect_admin_auth_tokenを自動的に使う(このLambdaの実行ロールにdsql:DbConnectAdmin
    // が必要——通常のdsql:DbConnectとは別のIAMアクション)。
    let database_url = format!(
        "postgres://admin@{}:5432/postgres?sslmode=require",
        request.resource_properties.cluster_endpoint
    );
    let pool = aurora_dsql_sqlx_connector::pool::connect(&database_url).await?;

    apply_schema(&pool).await?;
    ensure_app_role(&pool).await?;
    for role_arn in &request.resource_properties.lambda_role_arns {
        grant_iam_role(&pool, role_arn).await?;
    }

    Ok(CustomResourceResponse { physical_resource_id })
}

/// SCHEMA_SQLを1文ずつに分割する。sqlxの`query()`はprepared statement経由で実行するため、
/// psqlの`-c`(simple query protocol、旧apply-schema.shはこちらだった)と違い、1回の呼び出しに
/// 複数コマンドを含められない。空行区切りではなく`;`そのもので分割することで、空行なしで
/// 連続する文(例: 2つのCREATE INDEX ASYNC)も正しく1文ずつに分かれるようにする。
async fn apply_schema(pool: &PgPool) -> Result<(), Error> {
    for chunk in SCHEMA_SQL.split(';') {
        let statement = chunk.trim();
        if statement.is_empty() {
            continue;
        }
        run_idempotent(pool, format!("{statement};")).await?;
    }
    Ok(())
}

async fn ensure_app_role(pool: &PgPool) -> Result<(), Error> {
    run_idempotent(pool, format!("CREATE ROLE {APP_DB_ROLE} WITH LOGIN;")).await?;
    // GRANTはPostgres上元々べき等(同じ権限を再度与えてもエラーにならない)。
    run_idempotent(
        pool,
        format!("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO {APP_DB_ROLE};"),
    )
    .await
}

async fn grant_iam_role(pool: &PgPool, role_arn: &str) -> Result<(), Error> {
    // role_arnはCDKの構築物(Lambda実行ロール)から来る値であり、利用者からの入力ではない。
    run_idempotent(pool, format!("AWS IAM GRANT {APP_DB_ROLE} TO '{role_arn}';")).await
}

/// 「既に存在する/既に付与済み」に類するエラーだけを無視し、それ以外は伝播させて
/// Custom ResourceをFAILEDにする(想定外のエラーを握りつぶさない)。
///
/// `AssertSqlSafe`: sqlxはSQLインジェクション対策として動的な文字列を`query()`にそのまま
/// 渡すことをコンパイル時に禁じている。ここで組み立てるDDL/DCL文はDBスキーマ定義(schema.sql)
/// とCDKの構築物(role_arn)由来であり、利用者からの入力を一切含まないため安全であると判断する。
async fn run_idempotent(pool: &PgPool, statement: String) -> Result<(), Error> {
    match sqlx::query(sqlx::AssertSqlSafe(statement.clone())).execute(pool).await {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(db_err)) if is_already_applied(db_err.as_ref()) => {
            tracing::info!(statement, "already applied, skipping");
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

fn is_already_applied(err: &dyn sqlx::error::DatabaseError) -> bool {
    // Postgresの重複オブジェクト系SQLSTATE: 42710=duplicate_object(ロール等)、
    // 42P07=duplicate_table、42701=duplicate_column、42P06=duplicate_schema、
    // 42723=duplicate_function。DSQL固有の"AWS IAM GRANT"再実行時のエラー分類が
    // 未確認なため、メッセージ文言でのフォールバック判定も併用する。
    const DUPLICATE_OBJECT_CODES: &[&str] = &["42710", "42P07", "42701", "42P06", "42723"];
    if let Some(code) = err.code() {
        if DUPLICATE_OBJECT_CODES.contains(&code.as_ref()) {
            return true;
        }
    }
    let message = err.message().to_lowercase();
    message.contains("already exists") || message.contains("already granted")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_statements(sql: &str) -> Vec<&str> {
        sql.split(';').map(str::trim).filter(|s| !s.is_empty()).collect()
    }

    #[test]
    fn schema_sql_splits_into_nonempty_statements_each_ending_in_semicolon() {
        let statements = split_statements(SCHEMA_SQL);

        assert!(!statements.is_empty());
        for statement in &statements {
            assert!(
                statement.to_uppercase().contains("CREATE") || statement.to_uppercase().contains("ALTER"),
                "unexpected statement shape: {statement}"
            );
        }
    }

    /// 空行区切りではなく`;`区切りにした理由そのものを検証する回帰テスト。schema.sql上
    /// 空行なしで連続する2つのCREATE INDEX ASYNC文が、prepared statementに複数コマンドを
    /// 詰め込んでしまう形(1つの塊)に戻っていないことを確認する。
    #[test]
    fn adjacent_statements_without_a_blank_line_are_still_split_individually() {
        let statements = split_statements(SCHEMA_SQL);
        let index_statements: Vec<_> = statements
            .iter()
            .filter(|s| s.to_uppercase().contains("CREATE INDEX"))
            .collect();

        assert_eq!(index_statements.len(), 2, "expected 2 separate CREATE INDEX statements: {index_statements:?}");
        for statement in index_statements {
            assert!(!statement.contains(';'), "statement should contain at most one command: {statement}");
        }
    }
}
