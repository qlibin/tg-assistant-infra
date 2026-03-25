import { z } from "zod";
import { PrioritySchema, SCHEMA_VERSION, TaskTypeSchema } from "./common.js";

const RetryPolicySchema = z.object({
  maxRetries: z.number().int().max(3).optional(),
  backoffMultiplier: z.number().min(1.0).max(5.0).optional(),
});

const PayloadSchema = z.object({
  url: z.string().url().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().min(30).max(900).optional(),
  retryPolicy: RetryPolicySchema.optional(),
});

export const OrderMessageSchema = z.object({
  orderId: z.string().uuid(),
  taskType: TaskTypeSchema,
  payload: PayloadSchema,
  userId: z.string().min(1),
  timestamp: z.string().datetime(),
  priority: PrioritySchema.optional(),
  retryCount: z.number().int().min(0).max(3).optional(),
  deduplicationId: z.string().max(128).optional(),
  correlationId: z.string().optional(),
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
});

export type OrderMessage = z.infer<typeof OrderMessageSchema>;
