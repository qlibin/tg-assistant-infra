# Infrastructure (AWS CDK)

This directory contains the AWS CDK application for the project's core messaging infrastructure.
The stack implements a stable, dual-queue SQS pattern with encryption, least‑privilege IAM, and
monitoring suitable for multiple environments.

## What this stack provides (high‑level)

- Two primary SQS queues for asynchronous processing:
  - Order queue: receives work items (produced by an ingress/Webhook service)
  - Result queue: receives processing results (produced by worker services)
- Dead Letter Queues (DLQs) for both primary queues
- KMS customer‑managed key with rotation enabled, used to encrypt all queues and the alert topic
- Three service IAM roles (no Lambda functions are defined here):
  - Webhook role: producer to the order queue
  - Worker role: consumer of the order queue and producer to the result queue
  - Feedback role: consumer of the result queue and producer back to the order queue (requeue)
- CloudWatch alarms for queue age and DLQ activity, wired to an SNS topic
- Export of essential identifiers and configuration to AWS Systems Manager Parameter Store

This design separates concerns (ingress → workers → feedback) and keeps responsibilities and
permissions minimal and explicit.

## Stack name and entrypoint

- CDK stack class: SQSStack (in lib/sqs-stack.ts)
- CDK app entrypoint: bin/ (typical CDK main file)
- The stack is parameterized by environment and project name; resource names follow the pattern:
  `<project>-<environment>-<purpose>`

## Parameters and configuration

The stack accepts common, stable inputs via props or CDK context:
- environment: short environment name (e.g., dev, staging, prod)
- projectName: short project identifier
- Optional queue tuning (visibility timeouts and max receive counts) with sensible defaults

The stack publishes the following categories to SSM Parameter Store for cross‑service consumption:
- Queue URLs and ARNs (order and result)
- Queue configuration (visibility timeouts and DLQ receive counts)
- IAM role ARNs (webhook, worker, feedback)
- SNS alert topic ARN (for wiring external alerting/observability)

Parameter names are namespaced under `/automation/<environment>/...` to keep environments isolated.

## Security model (summary)

- All queues are encrypted with a dedicated KMS key with rotation enabled
- Each service role has the minimum SQS and KMS permissions needed for its function
- No wildcard queue access; policies are scoped to specific queue ARNs

## Monitoring and alerting

- Alarms on age of oldest message for both primary queues
- Alarms on presence of messages in DLQs
- All alarms send notifications to an SNS topic used by external monitoring/alerting

## Development workflow

- Synthesize: `npm run synth`
- Deploy: `npm run deploy`
- Destroy: `npm run destroy`
- Validate (build, lint, format check, type‑check, tests): `npm run validate`

Tests are snapshot and assertion based and cover the full synthesized template at a high level.

## Conventions

- TypeScript strict mode and strong typing (no `any` in source)
- Import order: external → internal → relative
- Naming: camelCase (vars/functions), PascalCase (types/classes), kebab-case (files)
- Keep documentation high‑level and stable; avoid coupling docs to volatile implementation details
