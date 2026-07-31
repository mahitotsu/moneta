#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AccountPipelineStack } from "../lib/account-pipeline-stack";

const app = new cdk.App();
new AccountPipelineStack(app, "MonetaAccountPipelineStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Hardcoded: Aurora DSQL availability and this PoC's AWS session are both
    // scoped to ap-northeast-1 (Tokyo).
    region: "ap-northeast-1",
  },
});
