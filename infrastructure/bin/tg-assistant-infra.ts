#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { SQSStack } from "../lib/sqs-stack";

interface EnvConfig {
  account: string;
  region: string;
  envName: string;
  tags?: Record<string, string>;
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

// Optional account sanity check if AWS_ACCOUNT_ID is provided in environment
const providedAccountId = process.env.AWS_ACCOUNT_ID;
if (providedAccountId && providedAccountId !== envCfg.account) {
  throw new Error(
    `AWS account mismatch: AWS_ACCOUNT_ID=${providedAccountId} does not match CDK context account=${envCfg.account} for environment '${resolvedEnvName}'.`,
  );
}

const stack = new SQSStack(app, `DualQueueMessageStack-${envCfg.envName}`, {
  env: { account: envCfg.account, region: envCfg.region },
  description: `Dual SQS queues for TG Assistant (${envCfg.envName})`,
  environment: envCfg.envName,
  projectName: "tg-assistant",
  tags: envCfg.tags ?? {},
});

cdk.Tags.of(stack).add("app", "telegram-webhook");
cdk.Tags.of(stack).add("env", envCfg.envName);
