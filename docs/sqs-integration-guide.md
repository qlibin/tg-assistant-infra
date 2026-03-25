# SQS Integration Guide & Schema Registry Research

> **Audience:** Developers building Lambda microservices in **separate repos** that integrate with the shared SQS
> infrastructure defined in this repository.
>
> **Infrastructure source:** [`infrastructure/lib/sqs-stack.ts`](../infrastructure/lib/sqs-stack.ts)

---

## Table of Contents

- [Part 1: SQS Integration Guide](#part-1-sqs-integration-guide)
    - [Architecture Overview](#architecture-overview)
    - [SSM Parameter Store Reference](#ssm-parameter-store-reference)
    - [Role-Based Integration Patterns](#role-based-integration-patterns)
    - [Message Attribute Conventions](#message-attribute-conventions)
    - [Error Handling Patterns](#error-handling-patterns)
    - [Queue Configuration Quick Reference](#queue-configuration-quick-reference)
- [Part 2: Schema Registry Research & Recommendation](#part-2-schema-registry-research--recommendation)
    - [Approaches Evaluated](#approaches-evaluated)
    - [Recommendation](#recommendation)
    - [Implementation Roadmap](#implementation-roadmap)
- [Part 3: Message Schemas](#part-3-message-schemas)
    - [Order Message Schema](#order-message-schema)
    - [Result Message Schema](#result-message-schema)
    - [Schema Versioning Conventions](#schema-versioning-conventions)

---

## Part 1: SQS Integration Guide

### Architecture Overview

```
                          Dual-Queue Message Flow
  ┌─────────────┐
  │  Telegram   │
  │  Webhook    │
  └──────┬──────┘
         │ sqs:SendMessage
         ▼
  ┌──────────────┐     maxReceiveCount: 3     ┌──────────────┐
  │ Order Queue  │ ──── DLQ overflow ───────► │  Order DLQ   │
  │ (14d retain) │                            │  (7d retain) │
  └──────┬───────┘                            └──────────────┘
         │ SQS Event Source Mapping
         │ (with message attribute filtering)
         ▼
  ┌──────────────┐
  │   Worker     │
  │   Lambda(s)  │
  └──────┬───────┘
         │ sqs:SendMessage
         ▼
  ┌──────────────┐     maxReceiveCount: 3     ┌──────────────┐
  │ Result Queue │ ──── DLQ overflow ───────► │  Result DLQ  │
  │ (7d retain)  │                            │  (7d retain) │
  └──────┬───────┘                            └──────────────┘
         │ SQS Event Source Mapping
         ▼
  ┌──────────────┐          sqs:SendMessage          ┌──────────────┐
  │  Feedback    │ ──── requeue (if needed) ───────► │ Order Queue  │
  │  Lambda      │                                   └──────────────┘
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │  Telegram    │
  │  Notify User │
  └──────────────┘
```

**Key points:**

- All four queues share a single KMS encryption key with automatic rotation
- Each Lambda type has a dedicated IAM role with least-privilege permissions
- Workers consume from Order Queue and produce to Result Queue
- Feedback Lambda can requeue failed/retryable tasks back to Order Queue
- CloudWatch alarms + SNS topic provide monitoring for queue age and DLQ activity

### SSM Parameter Store Reference

All parameters are exported under `/automation/{environment}/...` where `{environment}` is `dev`, `test`, or `prod`.

| SSM Parameter Path                                    | Description                                        | Used By                         |
|-------------------------------------------------------|----------------------------------------------------|---------------------------------|
| `/automation/{env}/queues/order/url`                  | Order Queue URL                                    | Webhook, Feedback (requeue)     |
| `/automation/{env}/queues/order/arn`                  | Order Queue ARN                                    | Worker (event source mapping)   |
| `/automation/{env}/queues/result/url`                 | Result Queue URL                                   | Worker                          |
| `/automation/{env}/queues/result/arn`                 | Result Queue ARN                                   | Feedback (event source mapping) |
| `/automation/{env}/queues/config`                     | JSON config (visibility timeouts, maxReceiveCount) | All Lambdas                     |
| `/automation/{env}/roles/webhook/arn`                 | Webhook Lambda IAM Role ARN                        | Webhook Lambda CDK stack        |
| `/automation/{env}/roles/worker/arn`                  | Worker Lambda IAM Role ARN                         | Worker Lambda CDK stack         |
| `/automation/{env}/roles/feedback/arn`                | Feedback Lambda IAM Role ARN                       | Feedback Lambda CDK stack       |
| `/automation/{env}/monitoring/queue-alerts/topic-arn` | SNS Topic ARN for queue alerts                     | Watch Tower / alerting service  |

**Reading SSM parameters at runtime (TypeScript):**

```typescript
import {SSMClient, GetParameterCommand} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({region: "eu-central-1"});
const env = process.env.ENVIRONMENT ?? "dev";

const {Parameter} = await ssm.send(
  new GetParameterCommand({
    Name: `/automation/${env}/queues/order/url`,
  }),
);
const orderQueueUrl = Parameter!.Value!;
```

**Importing role ARN in a consumer CDK stack:**

```typescript
import {StringParameter} from "aws-cdk-lib/aws-ssm";
import {Role} from "aws-cdk-lib/aws-iam";

const workerRoleArn = StringParameter.valueForStringParameter(
  this,
  `/automation/${environment}/roles/worker/arn`,
);
const workerRole = Role.fromRoleArn(this, "ImportedWorkerRole", workerRoleArn);
```

### Role-Based Integration Patterns

#### Webhook Lambda (Order Producer)

The Webhook Lambda receives Telegram updates and enqueues tasks into the Order Queue.

**Permissions granted:** `sqs:SendMessage`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl` on Order Queue + `kms:Decrypt`,
`kms:GenerateDataKey` on the encryption key.

```typescript
import {SQSClient, SendMessageCommand} from "@aws-sdk/client-sqs";
import {SSMClient, GetParameterCommand} from "@aws-sdk/client-ssm";
import {randomUUID} from "node:crypto";

const sqs = new SQSClient({region: "eu-central-1"});
const ssm = new SSMClient({region: "eu-central-1"});
const env = process.env.ENVIRONMENT ?? "dev";

// Cache the queue URL (fetch once per cold start)
let orderQueueUrl: string | undefined;

async function getOrderQueueUrl(): Promise<string> {
  if (!orderQueueUrl) {
    const {Parameter} = await ssm.send(
      new GetParameterCommand({
        Name: `/automation/${env}/queues/order/url`,
      }),
    );
    orderQueueUrl = Parameter!.Value!;
  }
  return orderQueueUrl;
}

async function sendOrder(order: OrderMessage): Promise<string> {
  const queueUrl = await getOrderQueueUrl();

  const {MessageId} = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(order),
      MessageAttributes: {
        TaskType: {DataType: "String", StringValue: order.taskType},
        Priority: {DataType: "String", StringValue: order.priority ?? "normal"},
        UserId: {DataType: "String", StringValue: order.userId},
        CorrelationId: {
          DataType: "String",
          StringValue: order.correlationId ?? order.orderId,
        },
      },
    }),
  );

  return MessageId!;
}
```

#### Worker Lambda (Order Consumer + Result Producer)

Workers are triggered by an SQS event source mapping on the Order Queue. After processing, they send results to the
Result Queue.

**Permissions granted:**

- Order Queue: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`
- Result Queue: `sqs:SendMessage`, `sqs:GetQueueAttributes`
- KMS: `kms:Decrypt`, `kms:GenerateDataKey`

**CDK event source mapping (in the worker Lambda's own CDK stack):**

```typescript
import {SqsEventSource} from "aws-cdk-lib/aws-lambda-event-sources";
import {Queue} from "aws-cdk-lib/aws-sqs";

// Import the Order Queue by ARN from SSM
const orderQueueArn = StringParameter.valueForStringParameter(
  this,
  `/automation/${environment}/queues/order/arn`,
);
const orderQueue = Queue.fromQueueArn(this, "ImportedOrderQueue", orderQueueArn);

workerLambda.addEventSource(
  new SqsEventSource(orderQueue, {
    batchSize: 5,
    maxBatchingWindow: Duration.seconds(10),
    reportBatchItemFailures: true, // Critical: enables partial batch failure
    filterEncryption: undefined,   // Filtering works with KMS-encrypted queues
    filters: [
      // Optional: filter to specific task types
      FilterCriteria.filter({
        body: {
          taskType: FilterRule.isEqual("playwright-scraping"),
        },
      }),
    ],
  }),
);
```

**Lambda handler with batch item failure reporting:**

```typescript
import {SQSHandler, SQSBatchResponse} from "aws-lambda";
import {SQSClient, SendMessageCommand} from "@aws-sdk/client-sqs";
import {SSMClient, GetParameterCommand} from "@aws-sdk/client-ssm";

const sqs = new SQSClient({region: "eu-central-1"});
const ssm = new SSMClient({region: "eu-central-1"});
const env = process.env.ENVIRONMENT ?? "dev";

let resultQueueUrl: string | undefined;

async function getResultQueueUrl(): Promise<string> {
  if (!resultQueueUrl) {
    const {Parameter} = await ssm.send(
      new GetParameterCommand({
        Name: `/automation/${env}/queues/result/url`,
      }),
    );
    resultQueueUrl = Parameter!.Value!;
  }
  return resultQueueUrl;
}

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const queueUrl = await getResultQueueUrl();

  for (const record of event.Records) {
    try {
      const order: OrderMessage = JSON.parse(record.body);
      const startTime = Date.now();

      const processResult = await processOrder(order);

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            orderId: order.orderId,
            correlationId: order.correlationId ?? order.orderId,
            taskType: order.taskType,
            status: processResult.success ? "success" : "failure",
            result: processResult.data,
            processingTime: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            userId: order.userId,
            followUpAction: processResult.success ? "notify" : "requeue",
            priority: order.priority ?? "normal",
          } satisfies ResultMessage),
          MessageAttributes: {
            Status: {
              DataType: "String",
              StringValue: processResult.success ? "success" : "failure",
            },
            TaskType: {DataType: "String", StringValue: order.taskType},
            FollowUpAction: {
              DataType: "String",
              StringValue: processResult.success ? "notify" : "requeue",
            },
          },
        }),
      );
    } catch (error) {
      console.error(`Failed to process record ${record.messageId}:`, error);
      batchItemFailures.push({itemIdentifier: record.messageId});
    }
  }

  return {batchItemFailures};
};
```

#### Feedback Lambda (Result Consumer + Order Requeue)

The Feedback Lambda consumes from the Result Queue and takes action based on `followUpAction`.

**Permissions granted:**

- Result Queue: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`
- Order Queue: `sqs:SendMessage`, `sqs:GetQueueAttributes` (for requeue)
- KMS: `kms:Decrypt`, `kms:GenerateDataKey`

```typescript
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const orderQueueUrl = await getOrderQueueUrl();

  for (const record of event.Records) {
    try {
      const result: ResultMessage = JSON.parse(record.body);

      switch (result.followUpAction) {
        case "notify":
          await sendTelegramNotification(result.userId, result);
          break;

        case "enhance":
          const enhanced = await enhanceWithPerplexity(result);
          await sendTelegramNotification(result.userId, enhanced);
          break;

        case "requeue":
          if ((result.retryCount ?? 0) < 3) {
            await sqs.send(
              new SendMessageCommand({
                QueueUrl: orderQueueUrl,
                MessageBody: JSON.stringify({
                  orderId: randomUUID(),
                  taskType: result.taskType,
                  payload: result.result?.data ?? {},
                  userId: result.userId,
                  timestamp: new Date().toISOString(),
                  priority: result.priority,
                  retryCount: (result.retryCount ?? 0) + 1,
                  correlationId: result.correlationId,
                } satisfies OrderMessage),
                MessageAttributes: {
                  TaskType: {DataType: "String", StringValue: result.taskType},
                  Priority: {DataType: "String", StringValue: result.priority ?? "normal"},
                },
              }),
            );
          } else {
            console.warn(`Max retries reached for correlation ${result.correlationId}`);
            await sendTelegramNotification(result.userId, {
              ...result,
              status: "failure",
            });
          }
          break;

        case "escalate":
          await sendTelegramNotification(result.userId, result);
          // Future: page on-call or create incident
          break;

        case "archive":
          // Future: persist to DynamoDB or S3
          console.log(`Archived result for order ${result.orderId}`);
          break;
      }
    } catch (error) {
      console.error(`Failed to process result ${record.messageId}:`, error);
      batchItemFailures.push({itemIdentifier: record.messageId});
    }
  }

  return {batchItemFailures};
};
```

### Message Attribute Conventions

SQS message attributes are used for filtering and routing. Always set them when sending messages so that consumers can
use event source filter criteria.

| Attribute        | DataType | Used On                   | Values                                                                                                                                                                            |
|------------------|----------|---------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `TaskType`       | String   | Order Queue, Result Queue | `playwright-scraping`, `url-monitoring`, `web-automation`, `perplexity-summary`, `content-analysis`, `text-processing`, `scheduled-linkedin`, `scheduled-german`, `system-health` |
| `Priority`       | String   | Order Queue, Result Queue | `low`, `normal`, `high`, `critical`                                                                                                                                               |
| `UserId`         | String   | Order Queue               | Telegram user ID                                                                                                                                                                  |
| `CorrelationId`  | String   | Order Queue               | UUID linking related orders across retries                                                                                                                                        |
| `Status`         | String   | Result Queue              | `success`, `failure`, `partial`, `timeout`, `rate-limited`, `cancelled`                                                                                                           |
| `FollowUpAction` | String   | Result Queue              | `notify`, `requeue`, `enhance`, `escalate`, `archive`                                                                                                                             |

### Error Handling Patterns

#### Batch Item Failures

Always enable `reportBatchItemFailures: true` on the SQS event source mapping. Return failed message IDs in the
`batchItemFailures` array so that only failed messages are retried (not the entire batch).

```typescript
// Return type MUST be SQSBatchResponse
return {batchItemFailures: [{itemIdentifier: record.messageId}]};
```

If you don't report batch item failures, SQS retries the **entire batch** when any single message fails.

#### DLQ Flow

```
Message received by Lambda
  ├── Processing succeeds → message auto-deleted
  └── Processing fails → message returns to queue after visibility timeout
        ├── Retry 1 → fails again
        ├── Retry 2 → fails again
        └── Retry 3 → maxReceiveCount reached → moved to DLQ
```

- Order Queue: 3 attempts, then moved to Order DLQ (7-day retention)
- Result Queue: 3 attempts, then moved to Result DLQ (7-day retention)
- DLQ messages trigger CloudWatch alarms → SNS notifications

#### Visibility Timeout Considerations

- Order Queue: **300s (5 min)** — set your Lambda timeout to less than this
- Result Queue: **180s (3 min)** — feedback processing is typically faster

If your Lambda takes longer than the visibility timeout, the message becomes visible again and another invocation may
pick it up, causing duplicate processing. Set your Lambda timeout to ~80% of the visibility timeout.

### Queue Configuration Quick Reference

| Property               | Order Queue             | Result Queue             | Order DLQ                   | Result DLQ                   |
|------------------------|-------------------------|--------------------------|-----------------------------|------------------------------|
| **Queue name**         | `{project}-{env}-order` | `{project}-{env}-result` | `{project}-{env}-order-dlq` | `{project}-{env}-result-dlq` |
| **Visibility timeout** | 300s (5 min)            | 180s (3 min)             | —                           | —                            |
| **Retention period**   | 14 days                 | 7 days                   | 7 days                      | 7 days                       |
| **Long polling**       | 6s                      | 6s                       | —                           | —                            |
| **Max receive count**  | 3                       | 3                        | — (terminal)                | — (terminal)                 |
| **Encryption**         | KMS (rotation enabled)  | KMS (rotation enabled)   | KMS (rotation enabled)      | KMS (rotation enabled)       |

**Alarm thresholds:**

| Alarm               | Metric                             | Threshold     | Evaluation        |
|---------------------|------------------------------------|---------------|-------------------|
| Order message age   | ApproximateAgeOfOldestMessage      | 900s (15 min) | 2 periods @ 5 min |
| Result message age  | ApproximateAgeOfOldestMessage      | 600s (10 min) | 2 periods @ 3 min |
| Order DLQ activity  | ApproximateNumberOfMessagesVisible | >= 1          | 1 period          |
| Result DLQ activity | ApproximateNumberOfMessagesVisible | >= 1          | 1 period          |

---

## Part 2: Schema Registry Research & Recommendation

### Problem Statement

Multiple Lambda microservices in separate GitHub repos need to share message schemas for the Order and Result queues.
Currently, schemas exist only as documentation in this repo. There is no programmatic way for consumer repos to:

1. Import TypeScript types for order/result messages
2. Validate messages at build time or runtime
3. Track schema version compatibility across services

### Approaches Evaluated

#### 1. npm Package via GitHub Packages (Recommended)

Publish schemas as a versioned npm package from this repo.

**How it works:**

- Schemas live in a `contracts/` directory in this repo as JSON Schema files + TypeScript types
- Published as `@qlibin/tg-assistant-contracts` to GitHub Packages (free for public repos)
- Consumer repos install via `npm install @qlibin/tg-assistant-contracts`
- CI workflow auto-publishes on version tag

**Package structure:**

```
contracts/
  schemas/
    order-message.schema.json      # JSON Schema Draft-07
    result-message.schema.json
  types/
    order-message.ts               # TypeScript interfaces
    result-message.ts
    index.ts                       # Re-exports all types
  index.ts                         # Main entry: exports types + schema paths
  package.json
  tsconfig.json
```

**What consumers get:**

```typescript
import {
  OrderMessage,
  ResultMessage,
  ORDER_MESSAGE_SCHEMA,
  RESULT_MESSAGE_SCHEMA,
} from "@qlibin/tg-assistant-contracts";

// Type-safe message construction
const order: OrderMessage = {
  orderId: randomUUID(),
  taskType: "playwright-scraping",
  payload: {url: "https://example.com"},
  userId: "12345",
  timestamp: new Date().toISOString(),
};

// Optional: runtime validation with ajv
import Ajv from "ajv";

const ajv = new Ajv();
const validate = ajv.compile(ORDER_MESSAGE_SCHEMA);
if (!validate(order)) {
  throw new Error(`Invalid order: ${JSON.stringify(validate.errors)}`);
}
```

| Pros                                        | Cons                                    |
|---------------------------------------------|-----------------------------------------|
| Standard npm workflow                       | Requires npm package setup + publish CI |
| TypeScript types with IDE autocomplete      | Consumers must update package version   |
| Semver for compatibility tracking           | GitHub Packages auth for private repos  |
| Build-time type checking                    |                                         |
| Optional runtime validation via JSON Schema |                                         |

#### 2. JSON Schema Files in This Repo (Git Tag Versioning)

Store schemas as `.json` files and let consumers fetch them by git tag.

**How it works:**

- Schemas in `contracts/schemas/*.schema.json`
- Consumers fetch via raw GitHub URL pinned to a tag:
  `https://raw.githubusercontent.com/qlibin/tg-assistant-infra/v1.0.0/contracts/schemas/order-message.schema.json`
- No publishing step — just tag the repo

| Pros                         | Cons                                            |
|------------------------------|-------------------------------------------------|
| Simplest setup, zero tooling | No TypeScript types (consumers write their own) |
| Git tags = versions          | No dependency tracking                          |
| Works immediately            | Manual URL management                           |
|                              | No build-time validation                        |

#### 3. AWS Glue Schema Registry

Use AWS Glue's managed schema registry for centralized schema governance.

**How it works:**

- Schemas stored in AWS Glue Schema Registry (free tier, supports JSON Schema)
- CDK deploys schemas alongside queue infrastructure
- Lambdas validate messages at runtime via Glue SDK
- Supports compatibility modes: `BACKWARD`, `FORWARD`, `FULL`

```typescript
// CDK: Define schema in Glue
new glue.CfnSchema(this, "OrderMessageSchema", {
  name: "order-message",
  registryId: {registryName: "tg-assistant"},
  dataFormat: "JSON",
  compatibility: "BACKWARD",
  schemaDefinition: JSON.stringify(orderMessageSchema),
});
```

| Pros                                     | Cons                                            |
|------------------------------------------|-------------------------------------------------|
| AWS-native, centralized                  | No native SQS integration (custom SerDe needed) |
| Compatibility enforcement built-in       | No TypeScript types generated                   |
| Version history in AWS console           | Runtime overhead (Glue API calls)               |
| Works with Kafka/Kinesis if needed later | Overkill for small project with 3 Lambdas       |

#### 4. EventBridge Schema Registry

Use Amazon EventBridge Schema Registry with auto-discovery.

**How it works:**

- Primarily designed for EventBridge events
- Supports OpenAPI 3 and JSON Schema Draft 4
- Can auto-discover schemas from events
- Generates code bindings for multiple languages

| Pros                       | Cons                                          |
|----------------------------|-----------------------------------------------|
| Auto-discovery from events | Tightly coupled to EventBridge                |
| Code binding generation    | Not designed for SQS — no native integration  |
| AWS-managed                | Limited to JSON Schema Draft 4 (not Draft-07) |
|                            | Would require bridging SQS → EventBridge      |

#### 5. Hybrid: npm Package + Glue Schema Registry

Combine npm for development-time types with Glue for runtime validation.

**How it works:**

- npm package provides TypeScript types and JSON Schemas (approach 1)
- Glue Schema Registry enforces compatibility at the infrastructure level (approach 3)
- Best for projects that need both developer experience and operational governance

| Pros                                               | Cons                             |
|----------------------------------------------------|----------------------------------|
| Best developer experience + operational governance | More moving parts                |
| Type safety at build time                          | Two places to update schemas     |
| Compatibility enforcement at runtime               | Higher complexity for small team |
| Graceful evolution path                            |                                  |

### Recommendation

> **Implemented:** The `@qlibin/tg-assistant-contracts` package is available in `contracts/`. It uses **Zod** as the single source of truth (not raw JSON Schema + TypeScript interfaces as originally proposed) and publishes to **npmjs.com** (not GitHub Packages) for zero-auth consumer access. See `contracts/README.md` or `CLAUDE.md` for usage.

**Use approach 1: npm package via GitHub Packages.**

Rationale:

- **Right-sized for the project.** Three Lambda repos sharing two message schemas doesn't justify AWS Glue or
  EventBridge integration overhead.
- **TypeScript-first.** All consumers are TypeScript/Node.js — native types provide the most value.
- **Standard workflow.** `npm install` + semver is already understood by all consumers. No new tooling to learn.
- **Incremental.** Can add Glue Schema Registry later (approach 5) if the project grows to require runtime compatibility
  enforcement.

**Migration path if the project grows:**

1. Start with npm package (now)
2. Add `ajv` runtime validation in Lambdas using the same JSON Schemas from the package
3. If multi-team or multi-language consumers appear, add Glue Schema Registry alongside the npm package

### Implementation Roadmap

#### Step 1: Create `contracts/` directory in this repo

```
contracts/
  package.json
  tsconfig.json
  schemas/
    order-message.schema.json
    result-message.schema.json
  src/
    types/
      order-message.ts
      result-message.ts
      index.ts
    schemas.ts          # Re-exports JSON schemas as JS objects
    index.ts            # Main entry point
```

#### Step 2: `package.json` for the contracts package

```json
{
  "name": "@qlibin/tg-assistant-contracts",
  "version": "1.0.0",
  "description": "Shared message schemas and TypeScript types for tg-assistant SQS queues",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist/",
    "schemas/"
  ],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/qlibin/tg-assistant-infra.git",
    "directory": "contracts"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

#### Step 3: GitHub Actions publish workflow

```yaml
# .github/workflows/publish-contracts.yml
name: Publish Contracts
on:
  push:
    tags: [ "contracts-v*" ]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://npm.pkg.github.com
      - run: cd contracts && npm ci && npm run build && npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### Step 4: Consumer repo installation

```bash
npm install @qlibin/tg-assistant-contracts
```

---

## Part 3: Message Schemas

### Order Message Schema

JSON Schema (Draft-07) for messages sent to the Order Queue.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/qlibin/tg-assistant-infra/schemas/order-message/1.0.0",
  "title": "OrderMessage",
  "description": "Task order sent to the Order Queue for worker processing",
  "type": "object",
  "required": [
    "orderId",
    "taskType",
    "payload",
    "userId",
    "timestamp"
  ],
  "properties": {
    "orderId": {
      "type": "string",
      "format": "uuid",
      "description": "Unique identifier for this order (UUIDv4)"
    },
    "taskType": {
      "type": "string",
      "enum": [
        "playwright-scraping",
        "url-monitoring",
        "web-automation",
        "perplexity-summary",
        "content-analysis",
        "text-processing",
        "scheduled-linkedin",
        "scheduled-german",
        "system-health"
      ],
      "description": "Determines which worker processes this order"
    },
    "payload": {
      "type": "object",
      "description": "Task-specific input data",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri"
        },
        "parameters": {
          "type": "object"
        },
        "configuration": {
          "type": "object"
        },
        "timeout": {
          "type": "number",
          "minimum": 30,
          "maximum": 900,
          "description": "Task timeout in seconds"
        },
        "retryPolicy": {
          "type": "object",
          "properties": {
            "maxRetries": {
              "type": "number",
              "maximum": 3
            },
            "backoffMultiplier": {
              "type": "number",
              "minimum": 1.0,
              "maximum": 5.0
            }
          },
          "additionalProperties": false
        }
      }
    },
    "userId": {
      "type": "string",
      "minLength": 1,
      "description": "Telegram user ID of the requester"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of order creation"
    },
    "priority": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high",
        "critical"
      ],
      "default": "normal"
    },
    "retryCount": {
      "type": "number",
      "minimum": 0,
      "maximum": 3,
      "default": 0,
      "description": "Number of times this order has been requeued"
    },
    "deduplicationId": {
      "type": "string",
      "maxLength": 128,
      "description": "Client-provided deduplication token"
    },
    "correlationId": {
      "type": "string",
      "description": "Groups related orders across retries (persists across requeues)"
    },
    "schemaVersion": {
      "type": "string",
      "const": "1.0.0",
      "description": "Schema version for forward compatibility"
    }
  },
  "additionalProperties": false
}
```

**TypeScript interface:**

```typescript
export interface OrderMessage {
  orderId: string;
  taskType:
    | "playwright-scraping"
    | "url-monitoring"
    | "web-automation"
    | "perplexity-summary"
    | "content-analysis"
    | "text-processing"
    | "scheduled-linkedin"
    | "scheduled-german"
    | "system-health";
  payload: {
    url?: string;
    parameters?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
    timeout?: number;
    retryPolicy?: {
      maxRetries?: number;
      backoffMultiplier?: number;
    };
  };
  userId: string;
  timestamp: string;
  priority?: "low" | "normal" | "high" | "critical";
  retryCount?: number;
  deduplicationId?: string;
  correlationId?: string;
  schemaVersion?: "1.0.0";
}
```

### Result Message Schema

JSON Schema (Draft-07) for messages sent to the Result Queue.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/qlibin/tg-assistant-infra/schemas/result-message/1.0.0",
  "title": "ResultMessage",
  "description": "Processing result sent to the Result Queue for feedback handling",
  "type": "object",
  "required": [
    "orderId",
    "taskType",
    "status",
    "result",
    "processingTime",
    "timestamp",
    "userId"
  ],
  "properties": {
    "orderId": {
      "type": "string",
      "format": "uuid",
      "description": "ID of the original order"
    },
    "correlationId": {
      "type": "string",
      "description": "Links back to the original order chain"
    },
    "taskType": {
      "type": "string",
      "description": "Task type from the original order"
    },
    "status": {
      "type": "string",
      "enum": [
        "success",
        "failure",
        "partial",
        "timeout",
        "rate-limited",
        "cancelled"
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "data": {
          "type": "object"
        },
        "summary": {
          "type": "string",
          "maxLength": 1000
        },
        "metadata": {
          "type": "object",
          "properties": {
            "processingNode": {
              "type": "string"
            },
            "resourcesUsed": {
              "type": "object"
            },
            "errorDetails": {
              "type": "object"
            },
            "performanceMetrics": {
              "type": "object"
            }
          }
        },
        "size": {
          "type": "number",
          "maximum": 256000,
          "description": "Result size in bytes (SQS max message size = 256KB)"
        }
      }
    },
    "processingTime": {
      "type": "number",
      "description": "Processing time in milliseconds"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "userId": {
      "type": "string"
    },
    "followUpAction": {
      "type": "string",
      "enum": [
        "notify",
        "requeue",
        "enhance",
        "escalate",
        "archive"
      ],
      "description": "Action the Feedback Lambda should take"
    },
    "priority": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high",
        "critical"
      ]
    },
    "retryCount": {
      "type": "number",
      "minimum": 0,
      "maximum": 3,
      "description": "Carried from the order for requeue tracking"
    },
    "cost": {
      "type": "number",
      "minimum": 0,
      "description": "Processing cost in USD"
    },
    "queueMetrics": {
      "type": "object",
      "properties": {
        "queueTime": {
          "type": "number",
          "description": "Milliseconds spent in order queue"
        },
        "processingDelay": {
          "type": "number",
          "description": "Milliseconds delay before processing started"
        }
      },
      "additionalProperties": false
    },
    "schemaVersion": {
      "type": "string",
      "const": "1.0.0",
      "description": "Schema version for forward compatibility"
    }
  },
  "additionalProperties": false
}
```

**TypeScript interface:**

```typescript
export interface ResultMessage {
  orderId: string;
  correlationId?: string;
  taskType: string;
  status: "success" | "failure" | "partial" | "timeout" | "rate-limited" | "cancelled";
  result: {
    data?: Record<string, unknown>;
    summary?: string;
    metadata?: {
      processingNode?: string;
      resourcesUsed?: Record<string, unknown>;
      errorDetails?: Record<string, unknown>;
      performanceMetrics?: Record<string, unknown>;
    };
    size?: number;
  };
  processingTime: number;
  timestamp: string;
  userId: string;
  followUpAction?: "notify" | "requeue" | "enhance" | "escalate" | "archive";
  priority?: "low" | "normal" | "high" | "critical";
  retryCount?: number;
  cost?: number;
  queueMetrics?: {
    queueTime?: number;
    processingDelay?: number;
  };
  schemaVersion?: "1.0.0";
}
```

### Schema Versioning Conventions

#### Version Field

Every message should include `schemaVersion` (optional for backward compatibility with pre-versioning messages). The
version follows semver:

- **`1.0.0`** — initial release

#### Compatibility Rules

| Change Type                            | Semver Bump           | Example                                         |
|----------------------------------------|-----------------------|-------------------------------------------------|
| Add optional field                     | **Minor** (1.0 → 1.1) | Adding `metadata.region` to OrderMessage        |
| Add new enum value                     | **Minor** (1.0 → 1.1) | Adding `"data-export"` to `taskType`            |
| Change field from required to optional | **Minor** (1.0 → 1.1) | Making `processingTime` optional                |
| Remove a field                         | **Major** (1.x → 2.0) | Removing `deduplicationId`                      |
| Rename a field                         | **Major** (1.x → 2.0) | Renaming `orderId` to `taskId`                  |
| Change field type                      | **Major** (1.x → 2.0) | Changing `processingTime` from number to string |
| Make optional field required           | **Major** (1.x → 2.0) | Making `correlationId` required                 |

#### Backward Compatibility Guidelines

1. **Consumers must ignore unknown fields.** Do not use `additionalProperties: false` in runtime validation — only in
   schema documentation. This allows producers to add fields without breaking consumers.

2. **Producers must always include all required fields.** Never remove a required field in a minor version.

3. **Use `schemaVersion` for migration.** When a major version is released, consumers can check the version and handle
   both old and new formats during a transition period:

   ```typescript
   const message = JSON.parse(record.body);
   if (!message.schemaVersion || message.schemaVersion === "1.0.0") {
     // Handle v1 format
   } else if (message.schemaVersion === "2.0.0") {
     // Handle v2 format
   }
   ```

4. **Deploy consumers before producers.** When releasing a new schema version, update consumers first so they can handle
   the new format before producers start sending it.
