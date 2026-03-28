#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { SQSStack } from "../lib/sqs-stack.js";
import { ApiGatewayStack } from "../lib/api-gateway-stack.js";

interface EnvConfig {
  region: string;
  envName: string;
  tags?: Record<string, string>;
  existingDomainRegionalDomainName?: string;
  existingDomainRegionalHostedZoneId?: string;
}

const app = new cdk.App();

const environmentName =
  (app.node.tryGetContext("environment") as string | undefined) ??
  (app.node.tryGetContext("ENV_NAME") as string | undefined) ??
  undefined;

// Direct context reads without workarounds
const environments = app.node.tryGetContext("environments") as
  | Record<string, EnvConfig>
  | undefined;
const defaultEnvironment = app.node.tryGetContext("defaultEnvironment") as
  | string
  | undefined;

if (!environments || Object.keys(environments).length === 0) {
  throw new Error(
    "CDK context missing. Ensure cdk.json has context.environments configured.",
  );
}

const resolvedEnvName = environmentName ?? defaultEnvironment ?? "dev";
const envCfg = environments[resolvedEnvName];
if (!envCfg) {
  throw new Error(
    `Unknown environment '${resolvedEnvName}'. Available: ${Object.keys(environments).join(", ")}`,
  );
}

// AWS Account ID: required from environment variable
const account = process.env.AWS_ACCOUNT_ID;
if (!account) {
  throw new Error(
    "AWS_ACCOUNT_ID environment variable is required. " +
      "Set it in your shell or .env file for local development.",
  );
}

// Domain configuration: from environment variables (optional — ApiGateway stack only created when all present)
const certificateArn = process.env.CERTIFICATE_ARN;
const hostedZoneId = process.env.HOSTED_ZONE_ID;
const hostedZoneName = process.env.HOSTED_ZONE_NAME;
const domainName = process.env.DOMAIN_NAME;

const sqsStack = new SQSStack(app, `DualQueueMessageStack-${envCfg.envName}`, {
  env: { account, region: envCfg.region },
  description: `Dual SQS queues for TG Assistant (${envCfg.envName})`,
  environment: envCfg.envName,
  projectName: "tg-assistant",
  tags: envCfg.tags ?? {},
});

cdk.Tags.of(sqsStack).add("app", "telegram-webhook");
cdk.Tags.of(sqsStack).add("env", envCfg.envName);

// API Gateway Stack (only if domain configuration is available via env vars)
if (certificateArn && hostedZoneId && hostedZoneName && domainName) {
  const apiGatewayStack = new ApiGatewayStack(
    app,
    `ApiGatewayStack-${envCfg.envName}`,
    {
      env: { account, region: envCfg.region },
      description: `API Gateway for TG Assistant (${envCfg.envName})`,
      environment: envCfg.envName,
      projectName: "tg-assistant",
      certificateArn,
      hostedZoneId,
      hostedZoneName,
      domainName,
      basePath: envCfg.envName,
      existingDomainRegionalDomainName: envCfg.existingDomainRegionalDomainName,
      existingDomainRegionalHostedZoneId:
        envCfg.existingDomainRegionalHostedZoneId,
      tags: envCfg.tags ?? {},
    },
  );

  apiGatewayStack.addDependency(sqsStack);

  cdk.Tags.of(apiGatewayStack).add("app", "telegram-webhook");
  cdk.Tags.of(apiGatewayStack).add("env", envCfg.envName);
}
