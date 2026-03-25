import { z } from "zod";
import { PrioritySchema, SCHEMA_VERSION, TaskTypeSchema } from "./common.js";

export const StatusSchema = z.enum([
  "success",
  "failure",
  "partial",
  "timeout",
  "rate-limited",
  "cancelled",
]);

export type Status = z.infer<typeof StatusSchema>;

export const FollowUpActionSchema = z.enum([
  "notify",
  "requeue",
  "enhance",
  "escalate",
  "archive",
]);

export type FollowUpAction = z.infer<typeof FollowUpActionSchema>;

const ResultMetadataSchema = z.object({
  processingNode: z.string().optional(),
  resourcesUsed: z.record(z.string(), z.unknown()).optional(),
  errorDetails: z.record(z.string(), z.unknown()).optional(),
  performanceMetrics: z.record(z.string(), z.unknown()).optional(),
});

const ResultDataSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  summary: z.string().max(1000).optional(),
  metadata: ResultMetadataSchema.optional(),
  size: z.number().max(256000).optional(),
});

const QueueMetricsSchema = z.object({
  queueTime: z.number().optional(),
  processingDelay: z.number().optional(),
});

export const ResultMessageSchema = z.object({
  orderId: z.string().uuid(),
  correlationId: z.string().optional(),
  taskType: TaskTypeSchema,
  status: StatusSchema,
  result: ResultDataSchema,
  processingTime: z.number(),
  timestamp: z.string().datetime(),
  userId: z.string(),
  followUpAction: FollowUpActionSchema.optional(),
  priority: PrioritySchema.optional(),
  retryCount: z.number().int().min(0).max(3).optional(),
  cost: z.number().min(0).optional(),
  queueMetrics: QueueMetricsSchema.optional(),
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
});

export type ResultMessage = z.infer<typeof ResultMessageSchema>;
