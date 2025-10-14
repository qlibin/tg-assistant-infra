# CDK Bootstrap and GitHub Actions Permissions

This repository avoids running `cdk bootstrap` automatically in CI by default. Bootstrapping requires elevated IAM permissions (IAM, SSM, ECR, S3, CloudFormation) that typical deploy roles do not have. Run bootstrap once per account/region with an administrator or a role that has the required permissions, then leave the step disabled in CI.

## Why bootstrap failed in CI
The role assumed by GitHub Actions (`GithubActionsDeploymentRole`) was missing permissions such as:
- ssm:PutParameter for the CDK bootstrap version parameter
- iam:GetRole/CreateRole/DeleteRole for CDK asset publishing roles
- ecr:CreateRepository/DeleteRepository for container asset repository
- s3:CreateBucket/PutBucketPolicy for assets bucket
- cloudformation:* for managing the CDKToolkit stack

When these are missing, the bootstrap stack creation and rollback can fail.

## What changed
- The GitHub Actions workflow now makes bootstrap optional. By default, it is skipped.
- You can enable bootstrap temporarily by setting the repository variable `RUN_BOOTSTRAP` to `true`.
- When enabled, the workflow uses the modern bootstrap (`CDK_NEW_BOOTSTRAP=1`) and applies an execution policy of AdministratorAccess to the bootstrap’s CloudFormation execution role for smoother deployments.

See: .github/workflows/cd.yml

## Required permissions (least privilege)
A policy you can attach to the deployment role to permit bootstrapping is provided at:

infrastructure/policies/github-actions-bootstrap-policy.json

This includes the minimal actions for SSM, IAM role management for CDK-created roles, ECR repositories, S3 bootstrap bucket operations, and CloudFormation on the CDKToolkit stack. Adjust if your organization has SCPs or permission boundaries.

## Manual bootstrap steps (recommended)
1) Ensure your AWS account/region is clean of failed bootstrap artifacts:
   - In CloudFormation, delete any failed `CDKToolkit` stack.
   - Manually delete left-over IAM roles (e.g., `*PublishingRole*`), ECR repos for CDK assets, or S3 buckets if CloudFormation couldn’t remove them due to permissions.

2) From a workstation with admin permissions (or a temporary admin role), run:

   export CDK_NEW_BOOTSTRAP=1
   cdk bootstrap \
     --qualifier bl-dev \
     --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
     aws://<ACCOUNT_ID>/<REGION>

   Notes:
   - Replace `bl-dev` qualifier if you prefer another; keep it stable across CI and local.
   - Using AdministratorAccess on the bootstrap execution role is common during initial setup. You can tighten later.

3) Confirm bootstrap resources exist:
   - S3 assets bucket (look for `cdk-*-assets-<account>-<region>`)
   - ECR repository for container assets
   - IAM roles for file/image publishing

4) Re-run the pipeline. It should skip bootstrap and proceed to deploy.

## Optional: Enabling bootstrap in CI (temporary)
If you must let CI do the bootstrap (e.g., in a new account):
- Attach AdministratorAccess temporarily to the `GithubActionsDeploymentRole`, or
- Attach the policy in `infrastructure/policies/github-actions-bootstrap-policy.json` plus any organization-specific allowances.
- Set repository variable `RUN_BOOTSTRAP=true`.
- After successful bootstrap, revert the role back to least privilege and set `RUN_BOOTSTRAP=false`.

## Troubleshooting
- ssm:PutParameter denied: Ensure the role has ssm:PutParameter and no SCP blocks it.
- Cannot delete ECR repo or IAM role: Grant `ecr:DeleteRepository` and `iam:DeleteRole`, delete leftovers, then retry bootstrap.
- Organization SCP/permission boundaries: Verify they don’t explicitly deny the above actions during bootstrap.

## Security notes
- Do not hardcode account IDs, keys, or secrets in code.
- Prefer least-privilege for steady-state deployments; use broader permissions only during bootstrap and remove them afterwards.
