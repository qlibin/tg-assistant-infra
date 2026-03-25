# SQS Integration Guide

> **Audience:** Developers building Lambda microservices in **separate repos** that integrate with the shared SQS
> infrastructure defined in this repository.
>
> **Infrastructure source:** [`infrastructure/lib/sqs-stack.ts`](../infrastructure/lib/sqs-stack.ts)
>
> **Contracts package:** [`@qlibin/tg-assistant-contracts`](https://www.npmjs.com/package/@qlibin/tg-assistant-contracts)
> — shared Zod schemas and TypeScript types for all SQS messages
> ([source](../contracts/), [README](../contracts/README.md))

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Contracts Package](#contracts-package)
- [SSM Parameter Store Reference](#ssm-parameter-store-reference)
- [Role-Based Integration Patterns](#role-based-integration-patterns)
- [Message Attribute Conventions](#message-attribute-conventions)
- [Error Handling Patterns](#error-handling-patterns)
- [Queue Configuration Quick Reference](#queue-configuration-quick-reference)
- [Schema Versioning Conventions](#schema-versioning-conventions)

---

## Architecture Overview

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

---

## Contracts Package

All message types and validation are provided by
[`@qlibin/tg-assistant-contracts`](https://www.npmjs.com/package/@qlibin/tg-assistant-contracts).

```bash
npm install @qlibin/tg-assistant-contracts
```

### Exports

```typescript
import {
  // Zod schemas (runtime validation)
  OrderMessageSchema,
  ResultMessageSchema,

  // TypeScript types (inferred from Zod)
  OrderMessage,
  ResultMessage,

  // Enum types
  TaskType,
  Priority,
  Status,
  FollowUpAction,

  // Schema version constant
  SCHEMA_VERSION,             // "1.0.0"
} from "@qlibin/tg-assistant-contracts";
```

### Runtime Validation

Use Zod schemas to validate messages consumed from SQS:

```typescript
// Throws ZodError on invalid input
const order = OrderMessageSchema.parse(JSON.parse(record.body));

// Safe parsing (returns result object instead of throwing)
const result = OrderMessageSchema.safeParse(JSON.parse(record.body));
if (!result.success) {
  console.error("Invalid message:", result.error.flatten());
}
```

### Schema Details

#### OrderMessage

**Required:** `orderId` (UUID), `taskType`, `payload` (object), `userId`, `timestamp` (ISO 8601), `schemaVersion`

**Optional:** `priority`, `retryCount` (0-3), `deduplicationId` (max 128 chars), `correlationId`

#### ResultMessage

**Required:** `orderId` (UUID), `taskType`, `status`, `result` (object), `processingTime` (ms), `timestamp` (ISO 8601), `userId`, `schemaVersion`

**Optional:** `correlationId`, `followUpAction`, `priority`, `retryCount` (0-3), `cost` (USD), `queueMetrics`

See [`contracts/README.md`](../contracts/README.md) for full schema details including nested object structures and
validation rules.

---

## SSM Parameter Store Reference

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

---

## Role-Based Integration Patterns

### Webhook Lambda (Order Producer)

The Webhook Lambda receives Telegram updates and enqueues tasks into the Order Queue.

**Permissions granted:** `sqs:SendMessage`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl` on Order Queue + `kms:Decrypt`,
`kms:GenerateDataKey` on the encryption key.

```typescript
import {SQSClient, SendMessageCommand} from "@aws-sdk/client-sqs";
import {SSMClient, GetParameterCommand} from "@aws-sdk/client-ssm";
import {randomUUID} from "node:crypto";
import {OrderMessage, SCHEMA_VERSION} from "@qlibin/tg-assistant-contracts";

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

**Example: constructing an OrderMessage:**

```typescript
const order: OrderMessage = {
  orderId: randomUUID(),
  taskType: "playwright-scraping",
  payload: {url: "https://example.com"},
  userId: "12345",
  timestamp: new Date().toISOString(),
  schemaVersion: SCHEMA_VERSION,
};

await sendOrder(order);
```

### Worker Lambda (Order Consumer + Result Producer)

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
import {
  OrderMessage,
  OrderMessageSchema,
  ResultMessage,
  SCHEMA_VERSION,
} from "@qlibin/tg-assistant-contracts";

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
      const order: OrderMessage = OrderMessageSchema.parse(JSON.parse(record.body));
      const startTime = Date.now();

      const processResult = await processOrder(order);

      const resultMessage: ResultMessage = {
        orderId: order.orderId,
        correlationId: order.correlationId ?? order.orderId,
        taskType: order.taskType,
        status: processResult.success ? "success" : "failure",
        result: {data: processResult.data},
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        userId: order.userId,
        followUpAction: processResult.success ? "notify" : "requeue",
        priority: order.priority ?? "normal",
        schemaVersion: SCHEMA_VERSION,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(resultMessage),
          MessageAttributes: {
            Status: {
              DataType: "String",
              StringValue: resultMessage.status,
            },
            TaskType: {DataType: "String", StringValue: order.taskType},
            FollowUpAction: {
              DataType: "String",
              StringValue: resultMessage.followUpAction!,
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

### Feedback Lambda (Result Consumer + Order Requeue)

The Feedback Lambda consumes from the Result Queue and takes action based on `followUpAction`.

**Permissions granted:**

- Result Queue: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`
- Order Queue: `sqs:SendMessage`, `sqs:GetQueueAttributes` (for requeue)
- KMS: `kms:Decrypt`, `kms:GenerateDataKey`

```typescript
import {SQSHandler, SQSBatchResponse} from "aws-lambda";
import {SQSClient, SendMessageCommand} from "@aws-sdk/client-sqs";
import {randomUUID} from "node:crypto";
import {
  OrderMessage,
  ResultMessage,
  ResultMessageSchema,
  SCHEMA_VERSION,
} from "@qlibin/tg-assistant-contracts";

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const orderQueueUrl = await getOrderQueueUrl();

  for (const record of event.Records) {
    try {
      const result: ResultMessage = ResultMessageSchema.parse(JSON.parse(record.body));

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
            const requeue: OrderMessage = {
              orderId: randomUUID(),
              taskType: result.taskType,
              payload: {parameters: result.result?.data ?? {}},
              userId: result.userId,
              timestamp: new Date().toISOString(),
              priority: result.priority,
              retryCount: (result.retryCount ?? 0) + 1,
              correlationId: result.correlationId,
              schemaVersion: SCHEMA_VERSION,
            };
            await sqs.send(
              new SendMessageCommand({
                QueueUrl: orderQueueUrl,
                MessageBody: JSON.stringify(requeue),
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

---

## Message Attribute Conventions

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

---

## Error Handling Patterns

### Batch Item Failures

Always enable `reportBatchItemFailures: true` on the SQS event source mapping. Return failed message IDs in the
`batchItemFailures` array so that only failed messages are retried (not the entire batch).

```typescript
// Return type MUST be SQSBatchResponse
return {batchItemFailures: [{itemIdentifier: record.messageId}]};
```

If you don't report batch item failures, SQS retries the **entire batch** when any single message fails.

### DLQ Flow

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

### Visibility Timeout Considerations

- Order Queue: **300s (5 min)** — set your Lambda timeout to less than this
- Result Queue: **180s (3 min)** — feedback processing is typically faster

If your Lambda takes longer than the visibility timeout, the message becomes visible again and another invocation may
pick it up, causing duplicate processing. Set your Lambda timeout to ~80% of the visibility timeout.

---

## Queue Configuration Quick Reference

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

## Schema Versioning Conventions

### Version Field

Every message **must** include `schemaVersion` (currently `"1.0.0"`, exported as `SCHEMA_VERSION` from the contracts
package). The version follows semver.

### Compatibility Rules

| Change Type                            | Semver Bump           | Example                                         |
|----------------------------------------|-----------------------|-------------------------------------------------|
| Add optional field                     | **Minor** (1.0 → 1.1) | Adding `metadata.region` to OrderMessage        |
| Add new enum value                     | **Minor** (1.0 → 1.1) | Adding `"data-export"` to `taskType`            |
| Change field from required to optional | **Minor** (1.0 → 1.1) | Making `processingTime` optional                |
| Remove a field                         | **Major** (1.x → 2.0) | Removing `deduplicationId`                      |
| Rename a field                         | **Major** (1.x → 2.0) | Renaming `orderId` to `taskId`                  |
| Change field type                      | **Major** (1.x → 2.0) | Changing `processingTime` from number to string |
| Make optional field required           | **Major** (1.x → 2.0) | Making `correlationId` required                 |

### Backward Compatibility Guidelines

1. **Consumers must ignore unknown fields.** Do not use `additionalProperties: false` in runtime validation — only in
   schema documentation. This allows producers to add fields without breaking consumers.

2. **Producers must always include all required fields.** Never remove a required field in a minor version.

3. **Use `schemaVersion` for migration.** When a major version is released, consumers can check the version and handle
   both old and new formats during a transition period:

   ```typescript
   const message = JSON.parse(record.body);
   if (message.schemaVersion === "1.0.0") {
     // Handle v1 format
   } else if (message.schemaVersion === "2.0.0") {
     // Handle v2 format
   }
   ```

4. **Deploy consumers before producers.** When releasing a new schema version, update consumers first so they can handle
   the new format before producers start sending it.
