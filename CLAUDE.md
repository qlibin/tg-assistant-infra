# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS CDK infrastructure for a personal assistant Telegram bot. The infrastructure defines SQS-based messaging queues with encryption, IAM roles, CloudWatch alarms, and SSM parameter exports.

## Commands

### Contracts (`contracts/` directory)

```bash
npm run build          # Generate JSON schemas + TypeScript compilation
npm run lint           # ESLint validation
npm run format         # Format with Prettier
npm run format:check   # Check formatting
npm run test           # Run tests with coverage
npm run validate       # Full validation (build + lint + format + type-check + test)
```

### Infrastructure (`infrastructure/` directory)

```bash
npm run build          # TypeScript compilation
npm run lint           # ESLint validation
npm run lint:fix       # Auto-fix lint issues
npm run format         # Format with Prettier
npm run format:check   # Check formatting
npm run test           # Run tests with coverage
npm test -- -u         # Update snapshots when tests fail
npm run validate       # Full validation (build + lint + format + type-check + test)

# CDK commands
npm run synth          # Synthesize CloudFormation
npm run diff           # Show stack diff
npm run deploy         # Deploy stack
```

**AWS Profile:** Use `aws-course` for CDK and AWS CLI commands.

## Architecture

### Contracts Package (`contracts/`)

`@qlibin/tg-assistant-contracts` — shared Zod schemas and TypeScript types for SQS message formats. Published to npm public registry.

- **Zod as single source of truth**: schemas define both TypeScript types (`z.infer<>`) and generate JSON Schema files at build time via `zod-to-json-schema`.
- **Shared enums**: `TaskType` (9 values), `Priority` (4 values) used by both `OrderMessageSchema` and `ResultMessageSchema`.
- **Publishing**: Uses OIDC Trusted Publishing (no secrets needed). To publish a new version:
  1. Bump `version` in `contracts/package.json`
  2. Commit the version bump
  3. Tag: `git tag contracts-v<version>` (e.g., `git tag contracts-v1.1.0`)
  4. Push: `git push origin contracts-v<version>`
  5. The `.github/workflows/publish-contracts.yml` workflow validates, verifies the tag matches `package.json`, and publishes to npmjs.com with provenance.

### SQS Stack (`infrastructure/lib/sqs-stack.ts`)

Dual-queue messaging pattern:
- **Order Queue** → receives work items from webhook
- **Result Queue** → receives processing results from workers
- Both queues have Dead Letter Queues (DLQs)

Three Lambda IAM roles (no Lambdas defined here, just roles):
- **Webhook Role**: sends to Order queue
- **Worker Role**: consumes Order, produces to Result
- **Feedback Role**: consumes Result, can requeue to Order

All queues encrypted with KMS key (rotation enabled). CloudWatch alarms monitor queue age and DLQ activity, notifying an SNS topic.

### Environment Configuration

Environments (`dev`, `test`, `prod`) are defined in `infrastructure/cdk.json` context with non-sensitive config (region, envName, tags). Stack names follow pattern: `DualQueueMessageStack-{env}`. Resource names: `{project}-{env}-{purpose}`.

**Environment variables** (required for CDK synth/diff/deploy):

| Variable | Required | Source (CI/CD) | Purpose |
|---|---|---|---|
| `AWS_ACCOUNT_ID` | Yes | GH Variable | AWS account for stack deployment |
| `CERTIFICATE_ARN` | No | GH Variable | ACM certificate for custom domain |
| `HOSTED_ZONE_ID` | No | GH Variable | Route 53 hosted zone ID |
| `HOSTED_ZONE_NAME` | No | GH Variable | Route 53 zone name |
| `DOMAIN_NAME` | No | GH Variable | Custom domain name |

Domain-related variables are optional — the ApiGateway stack is only created when all four are provided. For local development, copy `infrastructure/.env.example` to `infrastructure/.env` and fill in values.

SSM parameters exported under `/automation/{environment}/...`.

## Deployment

Automated deployment via GitHub Actions workflows:
- **CI** (`.github/workflows/ci.yml`): Runs on PRs to validate and generate CDK diff
- **CD** (`.github/workflows/cd.yml`): Runs on main branch pushes to deploy changes

**AWS Authentication:** Uses `GithubActionsDeploymentRole` IAM role via OIDC (OpenID Connect).

**CDK Bootstrap:** Controlled by `RUN_BOOTSTRAP` GitHub environment variable. When set to `'true'`, runs CDK bootstrap during deployment. By default, assumes the account is pre-bootstrapped.

**Important:** When adding new AWS resources, ensure `GithubActionsDeploymentRole` has necessary permissions to deploy those resources. Follow principle of least privilege - grant only required permissions.

**Environment:** Deploys to `dev` environment by default (configurable via `ENV_NAME`).

## Testing

Uses Jest with CDK assertions and snapshot testing. Snapshot tests capture full CloudFormation template.

**Important:** Never remove snapshot tests. When snapshots fail due to intentional changes, update with `npm test -- -u`.

## Code Conventions

- No `any` type - use `unknown` or proper types
- Naming: camelCase (vars/functions), PascalCase (classes/interfaces), SCREAMING_SNAKE_CASE (constants), kebab-case (files)
- Import order: external libraries → internal modules → relative imports
- 85% minimum test coverage
- AAA pattern in tests (Arrange, Act, Assert)
