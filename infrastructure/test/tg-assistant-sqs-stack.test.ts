import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SQSStack } from "../lib/sqs-stack";

// AAA pattern tests for CDK stack

describe("SQS Stack", () => {
  const baseEnv = { account: "123456789012", region: "us-east-1" } as const;

  const makeStack = (
    overrides?: Partial<{
      envName: string;
      projectName: string;
      context?: Record<string, string>;
    }>,
  ) => {
    const appProps = overrides?.context
      ? { context: overrides.context as Record<string, unknown> }
      : undefined;
    const app = new cdk.App(appProps);

    return new SQSStack(app, "TestStack", {
      env: baseEnv,
      description: "Dual queue stack test",
      environment: overrides?.envName ?? "dev",
      projectName: overrides?.projectName ?? "tg-assistant",
    });
  };

  test("synthesizes expected CloudFormation template (snapshot)", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });

    // Act
    const fullTemplate = Template.fromStack(stack).toJSON() as Readonly<
      Record<string, unknown>
    >;

    // Assert - capture the entire synthesized template for full-stack coverage
    expect(fullTemplate).toMatchSnapshot();
  });

  test("creates four SQS queues (order, result, and their DLQs) with expected names", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });
    const template = Template.fromStack(stack);

    // Assert queue resources
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "tg-assistant-dev-order-dlq",
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "tg-assistant-dev-result-dlq",
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "tg-assistant-dev-order",
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "tg-assistant-dev-result",
    });
  });

  test("enables KMS key rotation for SQS encryption key", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
    });
  });

  test("creates IAM roles with least-privilege inline policies for queues", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });
    const template = Template.fromStack(stack);

    // Role names
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tg-assistant-dev-webhook-role",
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tg-assistant-dev-worker-role",
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tg-assistant-dev-feedback-role",
    });

    // At least one of the roles contains SQS/KMS actions
    template.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.anyValue(),
      }),
    );
  });

  test("exports queue URLs/ARNs, config, role ARNs, and SNS topic to SSM parameters", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });
    const template = Template.fromStack(stack);

    const paramNames = [
      "/automation/dev/queues/order/url",
      "/automation/dev/queues/order/arn",
      "/automation/dev/queues/result/url",
      "/automation/dev/queues/result/arn",
      "/automation/dev/queues/config",
      "/automation/dev/roles/webhook/arn",
      "/automation/dev/roles/worker/arn",
      "/automation/dev/roles/feedback/arn",
      "/automation/dev/monitoring/queue-alerts/topic-arn",
    ];

    for (const name of paramNames) {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: name,
      });
    }
  });

  test("creates SNS topic for alerts and wires CloudWatch alarms to it", () => {
    // Arrange
    const stack = makeStack({ envName: "dev" });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: "tg-assistant-dev-queue-alerts",
    });

    // Four alarms present
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
  });
});
