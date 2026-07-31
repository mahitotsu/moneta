import { App } from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AccountPipelineStack } from "../lib/account-pipeline-stack";

// cdk synthをそのまま走らせるテスト(Rust Lambdaのビルドを含む)。docs/adr/0004のQuery service
// 追加分(DynamoDB/EventBridge/Scheduler/REST API直接統合)が期待通り合成されることを確認する。
describe("AccountPipelineStack", () => {
  const app = new App();
  const stack = new AccountPipelineStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const template = Template.fromStack(stack);

  test("creates the account view DynamoDB table with on-demand billing", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-account-views",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
    });
  });

  test("creates a custom EventBridge bus and registers the domain event schema", () => {
    template.resourceCountIs("AWS::Events::EventBus", 1);
    template.hasResourceProperties("AWS::EventSchemas::Registry", {
      RegistryName: "moneta-account-service",
    });
    template.resourceCountIs("AWS::EventSchemas::Schema", 1);
  });

  test("schedules the outbox relay at the EventBridge Scheduler's 1-minute minimum interval", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 minute)",
    });
  });

  test("query service subscribes only to account.event.* detail-types, not rejections", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service"],
        "detail-type": [
          "account.event.Opened",
          "account.event.Deposited",
          "account.event.Withdrawn",
          "account.event.Frozen",
          "account.event.Unfrozen",
          "account.event.Closed",
        ],
      },
    });
  });

  test("creates exactly the three Lambda functions: write path, outbox relay, query projector", () => {
    template.resourceCountIs("AWS::Lambda::Function", 3);
  });

  test("exposes GET /accounts/{accountId} as a direct DynamoDB integration, not a Lambda proxy", () => {
    // Type: "AWS" (not "AWS_PROXY") is what distinguishes a direct service integration from a
    // Lambda proxy. The Uri itself synthesizes as a region-dependent Fn::Join, not a plain
    // string, so the request template's TableName/Key mapping is the more robust thing to assert.
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("TableName"), Match.stringLikeRegexp("accountId")]),
            ]),
          }),
        }),
      }),
    });
  });

  test("only account-service and the outbox relay get dsql:DbConnect (query projector never touches DSQL)", () => {
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({ Action: "dsql:DbConnect" })]),
        }),
      },
      2,
    );
  });
});
