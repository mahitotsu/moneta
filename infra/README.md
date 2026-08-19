# Moneta account-service infra (CDK, TypeScript)

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`    type-check the project
* `npm run watch`    watch for changes and type-check
* `npm run test`     run the jest unit tests (CDK assertions against `cdk synth`'s output)
* `npm run synth`    emit the synthesized CloudFormation template
* `npm run diff`     compare deployed stack with current state
* `npm run deploy`   deploy this stack to your default AWS account/region
* `npm run destroy`  tear down the deployed stack
* `npm run clean-data`      reset test data in the deployed stack (`scripts/clean-data.ts`) —
  wipes account/transfer DynamoDB tables and/or the SQS queues and/or e2e-created Cognito test
  users (`--only=dynamodb,sqs,cognito`, `--yes` to skip the confirmation prompt). Automatically
  protects `scripts/seed-demo-data.ts`'s demo data (see below) from deletion.
* `npm run seed-demo-data`  populate the deployed stack with persistent, non-e2e demo data
  (`scripts/seed-demo-data.ts`) — two Cognito users (`demo-customer`/`demo-customer-2`,
  password documented in the script) with a few accounts, a completed 振替, and two completed
  振込 between them (one each direction, docs/adr/0024) so both customers earn points and one
  of them redeems points against the second furikomi's fee — enough to see the fee/points
  header badge, breakdown, and history (docs/adr/0024〜0026) without having to run the e2e
  suites first. Idempotent (safe to re-run; no-ops once seeded) — **note**: because it's
  idempotent, data seeded before a feature that changes what `start`/`confirm` do (e.g. the fee
  charge added by `0024`) will NOT retroactively pick that feature up; delete the demo Cognito
  users and re-run to get fresh data reflecting current backend behavior.

`npm run deploy` provisions everything the app needs (DynamoDB tables, Lambdas, API Gateway,
Cognito, EventBridge) — there's no separate manual setup script to run afterward.

The E2E scenarios (`api-e2e/`, against the deployed stack over real HTTP) live in their own
top-level package, not here — see `api-e2e/README.md`. They're a consumer of this stack's
CloudFormation outputs, not part of the CDK app itself.

## Do not run `npx cdk ...` or `tsx scripts/...` directly

Use the `npm run` scripts above, not a bare `npx cdk deploy`/`synth`/`diff` (or a bare `tsx`
invocation of the scripts that talk to AWS). This dev sandbox's DNS resolver hangs ~15s on
AAAA queries, which makes any plain Node AWS SDK call -- or `fetch` straight to an API Gateway
endpoint -- time out (`Unable to resolve AWS account to use` for the CDK CLI; `ConnectTimeoutError`
for `fetch`), even though the `aws` CLI itself resolves credentials fine (it doesn't hit the same
DNS path). `force-ipv4.cjs` forces `dns.lookup` to IPv4-only to work around this; the `npm run
cdk`/`synth`/`diff`/`deploy`/`destroy`/`clean-data`/`seed-demo-data` scripts all load it via
`NODE_OPTIONS`. If you
do need to invoke one of these directly, prefix it yourself:
`NODE_OPTIONS="--require ./force-ipv4.cjs" <command>`. (`api-e2e/` has its own copy of this
workaround — see `api-e2e/README.md`.)
