#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AccountPipelineStack } from "../lib/account-pipeline-stack";

const app = new cdk.App();
new AccountPipelineStack(app, "MonetaAccountPipelineStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
