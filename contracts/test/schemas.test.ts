import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OrderMessageSchema,
  ResultMessageSchema,
  TaskTypeSchema,
  PrioritySchema,
  StatusSchema,
  FollowUpActionSchema,
  SCHEMA_VERSION,
} from "../src/index.js";
import type { OrderMessage, ResultMessage } from "../src/index.js";

const schemasDir = resolve(process.cwd(), "schemas");

function validOrderMessage(): OrderMessage {
  return {
    orderId: randomUUID(),
    taskType: "playwright-scraping",
    payload: { url: "https://example.com" },
    userId: "12345",
    timestamp: new Date().toISOString(),
  };
}

function validResultMessage(): ResultMessage {
  return {
    orderId: randomUUID(),
    taskType: "playwright-scraping",
    status: "success",
    result: { data: { html: "<p>test</p>" } },
    processingTime: 1500,
    timestamp: new Date().toISOString(),
    userId: "12345",
  };
}

describe("OrderMessageSchema", () => {
  it("accepts a valid minimal order message", () => {
    const msg = validOrderMessage();
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated order message", () => {
    const msg: OrderMessage = {
      ...validOrderMessage(),
      priority: "high",
      retryCount: 1,
      deduplicationId: "dedup-123",
      correlationId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      payload: {
        url: "https://example.com",
        parameters: { depth: 3 },
        configuration: { headless: true },
        timeout: 120,
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2.0,
        },
      },
    };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = OrderMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid orderId (not UUID)", () => {
    const msg = { ...validOrderMessage(), orderId: "not-a-uuid" };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects invalid taskType", () => {
    const msg = { ...validOrderMessage(), taskType: "unknown-task" };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects empty userId", () => {
    const msg = { ...validOrderMessage(), userId: "" };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects invalid timestamp", () => {
    const msg = { ...validOrderMessage(), timestamp: "not-a-date" };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects retryCount above max", () => {
    const msg = { ...validOrderMessage(), retryCount: 5 };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects payload timeout below minimum", () => {
    const msg = { ...validOrderMessage(), payload: { timeout: 10 } };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects payload timeout above maximum", () => {
    const msg = { ...validOrderMessage(), payload: { timeout: 1000 } };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("strips unknown properties for forward compatibility", () => {
    const msg = { ...validOrderMessage(), extraField: "nope" };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extraField");
    }
  });

  it("rejects invalid retryPolicy backoffMultiplier", () => {
    const msg = {
      ...validOrderMessage(),
      payload: { retryPolicy: { backoffMultiplier: 10.0 } },
    };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects deduplicationId exceeding max length", () => {
    const msg = {
      ...validOrderMessage(),
      deduplicationId: "x".repeat(129),
    };
    const result = OrderMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe("ResultMessageSchema", () => {
  it("accepts a valid minimal result message", () => {
    const msg = validResultMessage();
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated result message", () => {
    const msg: ResultMessage = {
      ...validResultMessage(),
      correlationId: randomUUID(),
      followUpAction: "notify",
      priority: "normal",
      retryCount: 0,
      cost: 0.05,
      queueMetrics: { queueTime: 200, processingDelay: 50 },
      schemaVersion: SCHEMA_VERSION,
      result: {
        data: { content: "scraped" },
        summary: "Successfully scraped page",
        metadata: {
          processingNode: "worker-1",
          resourcesUsed: { memory: 256 },
          errorDetails: {},
          performanceMetrics: { latencyP99: 120 },
        },
        size: 1024,
      },
    };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = ResultMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const msg = { ...validResultMessage(), status: "unknown" };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects invalid followUpAction", () => {
    const msg = { ...validResultMessage(), followUpAction: "unknown" };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects negative cost", () => {
    const msg = { ...validResultMessage(), cost: -1 };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects result size exceeding SQS max", () => {
    const msg = {
      ...validResultMessage(),
      result: { size: 300000 },
    };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects summary exceeding max length", () => {
    const msg = {
      ...validResultMessage(),
      result: { summary: "x".repeat(1001) },
    };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("strips unknown properties for forward compatibility", () => {
    const msg = { ...validResultMessage(), extraField: "nope" };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extraField");
    }
  });

  it("strips unknown properties in queueMetrics for forward compatibility", () => {
    const msg = {
      ...validResultMessage(),
      queueMetrics: { queueTime: 100, extra: true },
    };
    const result = ResultMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queueMetrics).not.toHaveProperty("extra");
    }
  });
});

describe("shared enums", () => {
  it("TaskTypeSchema accepts all 9 task types", () => {
    const taskTypes = [
      "playwright-scraping",
      "url-monitoring",
      "web-automation",
      "perplexity-summary",
      "content-analysis",
      "text-processing",
      "scheduled-linkedin",
      "scheduled-german",
      "system-health",
    ];
    for (const taskType of taskTypes) {
      expect(TaskTypeSchema.safeParse(taskType).success).toBe(true);
    }
    expect(TaskTypeSchema.options).toHaveLength(9);
  });

  it("PrioritySchema accepts all 4 priorities", () => {
    const priorities = ["low", "normal", "high", "critical"];
    for (const priority of priorities) {
      expect(PrioritySchema.safeParse(priority).success).toBe(true);
    }
    expect(PrioritySchema.options).toHaveLength(4);
  });

  it("StatusSchema accepts all 6 statuses", () => {
    const statuses = [
      "success",
      "failure",
      "partial",
      "timeout",
      "rate-limited",
      "cancelled",
    ];
    for (const status of statuses) {
      expect(StatusSchema.safeParse(status).success).toBe(true);
    }
    expect(StatusSchema.options).toHaveLength(6);
  });

  it("FollowUpActionSchema accepts all 5 actions", () => {
    const actions = ["notify", "requeue", "enhance", "escalate", "archive"];
    for (const action of actions) {
      expect(FollowUpActionSchema.safeParse(action).success).toBe(true);
    }
    expect(FollowUpActionSchema.options).toHaveLength(5);
  });
});

describe("SCHEMA_VERSION", () => {
  it("is 1.0.0", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });
});

describe("generated JSON Schema files", () => {
  it("order-message.schema.json exists and has correct structure", () => {
    const filePath = resolve(schemasDir, "order-message.schema.json");
    expect(existsSync(filePath)).toBe(true);

    const schema = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.title).toBe("OrderMessage");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
  });

  it("result-message.schema.json exists and has correct structure", () => {
    const filePath = resolve(schemasDir, "result-message.schema.json");
    expect(existsSync(filePath)).toBe(true);

    const schema = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.title).toBe("ResultMessage");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
  });
});
