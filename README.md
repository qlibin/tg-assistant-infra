# tg-assistant-infra

Shared AWS infrastructure for the Telegram personal assistant bot. Defines the SQS messaging backbone, API Gateway, IAM roles, KMS encryption, CloudWatch alarms, and SSM parameter exports consumed by all other repos in the system.

## Packages

| Directory         | Description                                                                                                           |
|-------------------|-----------------------------------------------------------------------------------------------------------------------|
| `contracts/`      | `@qlibin/tg-assistant-contracts` — shared Zod schemas and TypeScript types for SQS message formats (published to npm) |
| `infrastructure/` | AWS CDK stacks: SQS queues, API Gateway, IAM roles, KMS key, CloudWatch alarms                                        |

## System Architecture

This repo sits at the center of a three-repo pipeline:

```
Telegram → API Gateway (this repo)
               ↓
         Webhook Lambda (tg-assistant)
               ↓ sqs:SendMessage
         Order Queue (this repo)
               ↓ SQS event source
         Worker Lambda (tg-worker-*)
               ↓ sqs:SendMessage
         Result Queue (this repo)
               ↓ SQS event source
         Feedback Lambda (tg-assistant)
               ↓
           Telegram User
```

### SQS Stack

Dual-queue pattern with DLQs and KMS encryption:

- **Order Queue** — receives work items from the webhook lambda
- **Result Queue** — receives processing results from worker lambdas
- Both queues have Dead Letter Queues (7-day retention)

Three pre-built IAM roles (no Lambdas defined here — lambdas live in consumer repos):

| Role            | Permissions                                                                 |
|-----------------|-----------------------------------------------------------------------------|
| `webhook-role`  | `sqs:SendMessage` → Order Queue                                             |
| `worker-role`   | `sqs:ReceiveMessage/Delete` ← Order Queue, `sqs:SendMessage` → Result Queue |
| `feedback-role` | `sqs:ReceiveMessage/Delete` ← Result Queue, `sqs:SendMessage` → Order Queue |

### API Gateway Stack

HTTP API (v2) with a custom domain, per-environment stage, throttling, access logging, and CloudWatch alarms for 5XX errors and latency. Consumer lambdas attach their own routes using the API ID exported to SSM.

### SSM Parameter Exports

All cross-repo configuration is published to SSM under `/automation/{env}/...`:

| Parameter                     | Value                 |
|-------------------------------|-----------------------|
| `.../queues/order/url`        | Order Queue URL       |
| `.../queues/order/arn`        | Order Queue ARN       |
| `.../queues/result/url`       | Result Queue URL      |
| `.../queues/result/arn`       | Result Queue ARN      |
| `.../roles/webhook/arn`       | Webhook IAM Role ARN  |
| `.../roles/worker/arn`        | Worker IAM Role ARN   |
| `.../roles/feedback/arn`      | Feedback IAM Role ARN |
| `.../api-gateway/id`          | HTTP API ID           |
| `.../api-gateway/url`         | HTTP API URL          |
| `.../api-gateway/domain-name` | Custom domain name    |

### Contracts Package

`@qlibin/tg-assistant-contracts` — consumed by all three repos. Zod schemas are the single source of truth: they generate TypeScript types and JSON Schema files at build time.

Key types: `OrderMessageSchema`, `ResultMessageSchema`, `TaskType` (kebab-case string), `Priority` (`low | normal | high | critical`).

**Publishing a new version:**
1. Bump `version` in `contracts/package.json`
2. Commit, then `git tag contracts-v<version>` and push the tag
3. GitHub Actions publishes to npm via OIDC (no secrets needed)

## Local Development

Copy `infrastructure/.env.example` to `infrastructure/.env` and fill in `AWS_ACCOUNT_ID` and the optional domain variables.

```bash
# Contracts
cd contracts
npm run validate       # build + lint + format + type-check + test

# Infrastructure
cd infrastructure
npm run validate       # build + lint + format + type-check + test
npm run diff           # show CDK diff against deployed stack
npm run deploy         # deploy (uses aws-course AWS profile)
```

## Deployment

- **CI** — runs on PRs: validates and generates a CDK diff as a PR comment
- **CD** — runs on main branch push: deploys to `dev` (configurable via `ENV_NAME`)
- **Auth** — GitHub Actions assumes `GithubActionsDeploymentRole` via OIDC

Deploy order when standing up a new environment:
1. `tg-assistant-infra` (this repo) — creates queues, roles, API Gateway, SSM params
2. `tg-assistant` — webhook + feedback lambdas attach to the shared API Gateway
3. `tg-worker-*` — workers import queue URLs and IAM roles from SSM

## Related Repos

- [tg-assistant-infra](https://github.com/qlibin/tg-assistant-infra) — shared SQS, API Gateway, IAM infrastructure
- [tg-assistant](https://github.com/qlibin/tg-assistant) — webhook + feedback Lambdas
- [tg-worker-echo](https://github.com/qlibin/tg-worker-echo) — canary worker Lambda for end-to-end pipeline testing
- [@qlibin/tg-assistant-contracts](https://www.npmjs.com/package/@qlibin/tg-assistant-contracts) — shared message schemas (published from `contracts/`)
