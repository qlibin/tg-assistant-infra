import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const TaskTypeSchema = z.enum([
  "playwright-scraping",
  "url-monitoring",
  "web-automation",
  "perplexity-summary",
  "content-analysis",
  "text-processing",
  "scheduled-linkedin",
  "scheduled-german",
  "system-health",
]);

export type TaskType = z.infer<typeof TaskTypeSchema>;

export const PrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export type Priority = z.infer<typeof PrioritySchema>;
