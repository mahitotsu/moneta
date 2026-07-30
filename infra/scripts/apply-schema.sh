#!/usr/bin/env bash
# Applies crates/account-service/schema.sql to a live Aurora DSQL cluster, one
# statement per transaction (DSQL requires each DDL statement to run in its own
# transaction -- see docs/adr/0002). Also creates the non-admin database role
# that the Lambda runtime connects as (dsql:DbConnect), separate from the admin
# role used here (dsql:DbConnectAdmin) -- see
# https://awslabs.github.io/aurora-dsql-starter-kit/database-roles-iam-authentication.html
#
# Usage:
#   ./apply-schema.sh <cluster-endpoint> <region> <lambda-execution-role-arn>
#
# Requires: aws cli (with credentials that have dsql:DbConnectAdmin on the cluster),
# docker (runs psql via the postgres:16-alpine image -- no local psql install needed).
set -euo pipefail

CLUSTER_ENDPOINT="${1:?usage: apply-schema.sh <cluster-endpoint> <region> <lambda-execution-role-arn>}"
REGION="${2:?usage: apply-schema.sh <cluster-endpoint> <region> <lambda-execution-role-arn>}"
LAMBDA_ROLE_ARN="${3:?usage: apply-schema.sh <cluster-endpoint> <region> <lambda-execution-role-arn>}"
APP_DB_ROLE="account_service_app"

SCHEMA_SQL="$(dirname "$0")/../../crates/account-service/schema.sql"

token() {
    aws dsql generate-db-connect-admin-auth-token \
        --hostname "$CLUSTER_ENDPOINT" \
        --region "$REGION"
}

run_sql() {
    docker run --rm -e PGPASSWORD="$(token)" postgres:16-alpine \
        psql "host=$CLUSTER_ENDPOINT port=5432 dbname=postgres user=admin sslmode=require" \
        -v ON_ERROR_STOP=1 \
        -c "$1"
}

echo "Applying schema.sql, one statement per transaction..."
# Split on blank-line-separated statements (matches schema.sql's current layout).
# Each is issued as a single -c invocation, i.e. its own transaction.
while IFS= read -r -d '' stmt; do
    [ -z "$(echo "$stmt" | tr -d '[:space:]')" ] && continue
    echo "--- $stmt"
    run_sql "$stmt"
done < <(awk 'BEGIN{RS=";\n\n"} {gsub(/^\n+|\n+$/,""); if (length($0) > 0) printf "%s;%c", $0, 0}' "$SCHEMA_SQL")

echo "Creating non-admin app role ($APP_DB_ROLE) and granting IAM + table access..."
run_sql "CREATE ROLE $APP_DB_ROLE WITH LOGIN;"
run_sql "AWS IAM GRANT $APP_DB_ROLE TO '$LAMBDA_ROLE_ARN';"
# No explicit "GRANT USAGE ON SCHEMA public": DSQL rejects it ("feature not
# supported on system entity", public is a system entity there), but USAGE on
# public is granted to PUBLIC by default anyway, same as stock PostgreSQL.
run_sql "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO $APP_DB_ROLE;"

echo "Done."
