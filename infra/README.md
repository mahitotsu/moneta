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

`npm run deploy` is self-contained: schema/role/IAM-grant setup on the DSQL cluster runs
automatically as part of the deploy via a Custom Resource (see docs/adr/0005), so there's no
separate manual script to run afterward.

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
cdk`/`synth`/`diff`/`deploy`/`destroy`/`clean-data` scripts all load it via `NODE_OPTIONS`. If you
do need to invoke one of these directly, prefix it yourself:
`NODE_OPTIONS="--require ./force-ipv4.cjs" <command>`. (`api-e2e/` has its own copy of this
workaround — see `api-e2e/README.md`.)
