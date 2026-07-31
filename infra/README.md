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

## Do not run `npx cdk ...` directly

Use the `npm run` scripts above, not a bare `npx cdk deploy`/`synth`/`diff`. This dev sandbox's DNS
resolver hangs ~15s on AAAA queries, which makes the CDK CLI's own Node AWS SDK time out resolving
the account/credentials (`Unable to resolve AWS account to use`), even though the `aws` CLI itself
resolves credentials fine (it doesn't hit the same DNS path). `force-ipv4.cjs` forces `dns.lookup`
to IPv4-only to work around this; the `npm run cdk`/`synth`/`diff`/`deploy`/`destroy` scripts all
load it via `NODE_OPTIONS`. If you do need to invoke `cdk` directly for some reason, prefix it
yourself: `NODE_OPTIONS="--require ./force-ipv4.cjs" npx cdk <command>`.
