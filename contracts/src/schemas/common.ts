import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const TaskTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    "Task type must be kebab-case (e.g. 'web-scraping', 'text-processing')",
  );

export type TaskType = z.infer<typeof TaskTypeSchema>;

export const PrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export type Priority = z.infer<typeof PrioritySchema>;
