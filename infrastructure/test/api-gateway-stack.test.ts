import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  ApiGatewayStack,
  ApiGatewayStackProps,
} from "../lib/api-gateway-stack";

// AAA pattern tests for CDK stack

describe("ApiGateway Stack", () => {
  const baseEnv = { account: "123456789012", region: "eu-central-1" } as const;

  const baseProps: Omit<ApiGatewayStackProps, "env"> = {
    description: "API Gateway stack test",
    environment: "dev",
    projectName: "tg-assistant",
    certificateArn:
      "arn:aws:acm:eu-central-1:123456789012:certificate/test-cert-id",
    hostedZoneId: "Z0063833342G11THSVYEP",
    hostedZoneName: "qlibin.com",
    domainName: "tg.qlibin.com",
    basePath: "dev",
  };

  // Helper for creating stack with NEW custom domain (greenfield)
  const makeStackWithNewDomain = (
    overrides?: Partial<{
      envName: string;
      throttling: { rateLimit?: number; burstLimit?: number };
    }>,
  ) => {
    const app = new cdk.App();

    return new ApiGatewayStack(app, "TestApiGatewayStack", {
      ...baseProps,
      env: baseEnv,
      environment: overrides?.envName ?? "dev",
      basePath: overrides?.envName ?? "dev",
      throttling: overrides?.throttling,
      // No existingDomain* props = creates new domain
    });
  };

  // Helper for creating stack with IMPORTED existing domain (production scenario)
  const makeStackWithImportedDomain = (
    overrides?: Partial<{
      envName: string;
      throttling: { rateLimit?: number; burstLimit?: number };
    }>,
  ) => {
    const app = new cdk.App();

    return new ApiGatewayStack(app, "TestApiGatewayStack", {
      ...baseProps,
      env: baseEnv,
      environment: overrides?.envName ?? "dev",
      basePath: overrides?.envName ?? "dev",
      throttling: overrides?.throttling,
      existingDomainRegionalDomainName:
        "d-ekl8ubthta.execute-api.eu-central-1.amazonaws.com",
      existingDomainRegionalHostedZoneId: "Z1U9ULNL0V5AJ3",
      createDnsRecord: false,
    });
  };

  describe("with imported existing domain (production scenario)", () => {
    test("synthesizes expected CloudFormation template (snapshot)", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });

      // Act
      const fullTemplate = Template.fromStack(stack).toJSON() as Readonly<
        Record<string, unknown>
      >;

      // Assert - capture the entire synthesized template for full-stack coverage
      expect(fullTemplate).toMatchSnapshot();
    });

    test("does NOT create custom domain resource when importing", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert - no DomainName resource created (v2)
      template.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    });

    test("does NOT create Route53 record when importing domain", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert - no Route53 record created
      template.resourceCountIs("AWS::Route53::RecordSet", 0);
    });

    test("creates API mapping referencing imported domain", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "test" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", {
        ApiMappingKey: "test",
        DomainName: "tg.qlibin.com",
      });
    });
  });

  describe("with new custom domain (greenfield scenario)", () => {
    test("creates custom domain with certificate ARN", () => {
      // Arrange
      const stack = makeStackWithNewDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
        DomainName: "tg.qlibin.com",
        DomainNameConfigurations: Match.arrayWith([
          Match.objectLike({
            CertificateArn:
              "arn:aws:acm:eu-central-1:123456789012:certificate/test-cert-id",
            EndpointType: "REGIONAL",
          }),
        ]),
      });
    });

    test("creates Route53 A record as alias to API Gateway", () => {
      // Arrange
      const stack = makeStackWithNewDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "tg.qlibin.com.",
        Type: "A",
        AliasTarget: Match.objectLike({
          DNSName: Match.anyValue(),
          HostedZoneId: Match.anyValue(),
        }),
      });
    });
  });

  describe("common resources (both scenarios)", () => {
    test("creates HTTP API with execute-api disabled", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
        Name: "tg-assistant-telegram-bot-api-dev",
        ProtocolType: "HTTP",
        DisableExecuteApiEndpoint: true,
      });
    });

    test("does not create any routes (consumers own their routes)", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert - no routes or integrations created
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 0);
      template.resourceCountIs("AWS::ApiGatewayV2::Integration", 0);
    });

    test("creates stage with throttling settings (10 rate, 25 burst) and auto-deploy", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "dev",
        AutoDeploy: true,
        DefaultRouteSettings: Match.objectLike({
          ThrottlingRateLimit: 10,
          ThrottlingBurstLimit: 25,
          DetailedMetricsEnabled: true,
        }),
      });
    });

    test("creates API mapping for environment", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", {
        ApiMappingKey: "dev",
      });
    });

    test("creates access log group with one month retention", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/apigateway/tg-assistant-dev-http-api",
        RetentionInDays: 30,
      });
    });

    test("configures access logging on the stage", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        AccessLogSettings: Match.objectLike({
          DestinationArn: Match.anyValue(),
          Format: Match.anyValue(),
        }),
      });
    });

    test("exports API details to SSM parameters", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      const paramNames = [
        "/automation/dev/api-gateway/id",
        "/automation/dev/api-gateway/url",
        "/automation/dev/api-gateway/domain-name",
        "/automation/dev/api-gateway/stage-name",
      ];

      // Assert
      for (const name of paramNames) {
        template.hasResourceProperties("AWS::SSM::Parameter", {
          Name: name,
        });
      }
    });

    test("creates CloudWatch alarms for 5XX errors and latency", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert - two alarms present
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);

      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "tg-assistant-dev-api-5xx-errors",
      });

      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "tg-assistant-dev-api-latency",
      });
    });

    test("creates SNS topic for API alerts and wires alarms to it", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "dev" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "tg-assistant-dev-api-alerts",
      });

      // Alarms should have SNS actions
      template.hasResourceProperties(
        "AWS::CloudWatch::Alarm",
        Match.objectLike({
          AlarmActions: Match.anyValue(),
          OKActions: Match.anyValue(),
        }),
      );
    });

    test("supports custom throttling settings", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({
        envName: "test",
        throttling: { rateLimit: 20, burstLimit: 50 },
      });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "test",
        DefaultRouteSettings: Match.objectLike({
          ThrottlingRateLimit: 20,
          ThrottlingBurstLimit: 50,
        }),
      });
    });

    test("uses environment-specific naming for test environment", () => {
      // Arrange
      const stack = makeStackWithImportedDomain({ envName: "test" });
      const template = Template.fromStack(stack);

      // Assert
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
        Name: "tg-assistant-telegram-bot-api-test",
      });

      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/automation/test/api-gateway/id",
      });

      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "tg-assistant-test-api-5xx-errors",
      });
    });
  });
});
