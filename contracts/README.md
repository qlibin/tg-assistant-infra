# @qlibin/tg-assistant-contracts

Shared message schemas and TypeScript types for the tg-assistant dual-queue SQS architecture.

Uses [Zod](https://zod.dev/) as the single source of truth — one schema definition gives you TypeScript types, runtime validation, and JSON Schema files with zero drift between them.

## Install

```bash
npm install @qlibin/tg-assistant-contracts
```

## Usage

```typescript
import {
  OrderMessage,         // TypeScript type (inferred from Zod)
  OrderMessageSchema,   // Zod schema (runtime validation)
  ResultMessage,
  ResultMessageSchema,
} from "@qlibin/tg-assistant-contracts";

// Type-safe message construction
const order: OrderMessage = {
  orderId: randomUUID(),
  taskType: "playwright-scraping",
  payload: { url: "https://example.com" },
  userId: "12345",
  timestamp: new Date().toISOString(),
};

// Runtime validation (e.g., when consuming from SQS)
const parsed = OrderMessageSchema.parse(JSON.parse(record.body));

// Safe parsing (returns result instead of throwing)
const result = OrderMessageSchema.safeParse(JSON.parse(record.body));
if (!result.success) {
  console.error("Invalid message:", result.error);
}
```

## Schemas

### OrderMessage

Messages sent to the Order Queue for worker processing.

**Required fields:** `orderId`, `taskType`, `payload`, `userId`, `timestamp`

**Optional fields:** `priority`, `retryCount`, `deduplicationId`, `correlationId`, `schemaVersion`

### ResultMessage

Processing results sent to the Result Queue for feedback handling.

**Required fields:** `orderId`, `taskType`, `status`, `result`, `processingTime`, `timestamp`, `userId`

**Optional fields:** `correlationId`, `followUpAction`, `priority`, `retryCount`, `cost`, `queueMetrics`, `schemaVersion`

### Shared enums

| Export           | Values                                                                                                                                                                            |
|------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `TaskType`       | `playwright-scraping`, `url-monitoring`, `web-automation`, `perplexity-summary`, `content-analysis`, `text-processing`, `scheduled-linkedin`, `scheduled-german`, `system-health` |
| `Priority`       | `low`, `normal`, `high`, `critical`                                                                                                                                               |
| `Status`         | `success`, `failure`, `partial`, `timeout`, `rate-limited`, `cancelled`                                                                                                           |
| `FollowUpAction` | `notify`, `requeue`, `enhance`, `escalate`, `archive`                                                                                                                             |

## JSON Schema files

Static JSON Schema (Draft-07) files are generated at build time and included in the published package under `schemas/`:

- `schemas/order-message.schema.json`
- `schemas/result-message.schema.json`

These can be used with validators like [ajv](https://ajv.js.org/) if you prefer JSON Schema validation over Zod's `.parse()`.

## Schema versioning

All messages support an optional `schemaVersion` field (currently `"1.0.0"`). See [Schema Versioning Conventions](../docs/sqs-integration-guide.md#schema-versioning-conventions) for compatibility rules.

## Publishing

See the publishing procedure in [CLAUDE.md](../CLAUDE.md#contracts-package-contracts).
