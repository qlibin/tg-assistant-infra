---
name: merge-dependabot-prs
description: Use this skill when the user wants to merge, process, or manage dependabot dependency update pull requests. Triggers on phrases like "merge dependabot PRs", "handle dependency updates", "process dependabot", "update dependencies via PRs", or when the user wants to batch dependency updates.
user-invocable: true
---

# Merge Dependabot PRs Skill

Manages dependabot pull requests by triaging, batching, and merging dependency updates safely — avoiding package-lock conflicts and dependency hell.

## Overview

This skill:
1. Audits all open dependabot PRs and their CI status
2. Categorizes them by risk (patch/minor vs. major, conflicts, test failures)
3. Groups safe updates into a combined PR
4. Handles complex upgrades individually
5. Uses dependabot bot commands via PR comments where helpful

## Tools

Always use `gh` CLI. Never use MCP GitHub tools.

## Step-by-Step Execution

### 1. Discover Open Dependabot PRs

```bash
gh pr list --author "app/dependabot" --state open --json number,title,headRefName,statusCheckRollup,mergeable,mergeStateStatus,labels,baseRefName \
  | jq '.[] | {number, title, head: .headRefName, mergeable, mergeState: .mergeStateStatus, checks: (.statusCheckRollup // []) | map(select(.conclusion != null)) | group_by(.conclusion) | map({(.[0].conclusion): length}) | add}'
```

More complete listing:
```bash
gh pr list --author "app/dependabot" --state open --limit 100 \
  --json number,title,headRefName,mergeable,mergeStateStatus,statusCheckRollup
```

### 2. Check CI Status Per PR

For each PR, determine:
- `mergeable`: is there a merge conflict?
- `mergeStateStatus`: CLEAN | BEHIND | BLOCKED | DIRTY | UNKNOWN
- `statusCheckRollup`: all checks passed?

```bash
gh pr view <number> --json number,title,mergeable,mergeStateStatus,statusCheckRollup,commits
```

Quick status summary across all PRs:
```bash
gh pr list --author "app/dependabot" --state open --limit 100 \
  --json number,title,mergeStateStatus,statusCheckRollup \
  | jq '.[] | {number, title, state: .mergeStateStatus, passed: ([.statusCheckRollup[]? | select(.conclusion=="SUCCESS")] | length), failed: ([.statusCheckRollup[]? | select(.conclusion=="FAILURE")] | length)}'
```

### 3. Categorize PRs

**Tier 1 — Immediate merge candidates** (all of these must be true):
- `mergeStateStatus == "CLEAN"`
- All status checks passed (no failures)
- Patch or minor version bump (not major)
- No package-lock conflict with other Tier 1 PRs in the batch

**Tier 2 — Needs rebase** (CI passed but branch is behind main):
- `mergeStateStatus == "BEHIND"`
- Use dependabot rebase comment: `@dependabot rebase`

**Tier 3 — Needs investigation** (CI failures or conflicts):
- Failed checks → read the failure, determine if it's a flaky test or real breakage
- Merge conflicts → likely package-lock; needs manual resolution or `@dependabot recreate`
- Major version bumps → handle individually, may need code changes

### 4. Detect package-lock Conflicts Between PRs

When batching multiple Tier 1 PRs, package-lock.json will have conflicts since each PR regenerated it independently. The strategy:

- **Never cherry-pick from multiple dependabot branches directly** — package-lock will conflict
- Instead: create a new branch from main, apply only the `package.json` changes (version bumps), then run `npm install` to regenerate package-lock cleanly

```bash
# Create batch branch
git checkout main && git pull
git checkout -b deps/batch-$(date +%Y-%m-%d)

# For each PR in the batch, extract only the package.json change:
gh pr diff <number> -- package.json packages/*/package.json | git apply

# Then regenerate the lock file
npm install

# Commit + push
git add package*.json packages/*/package.json package-lock.json
git commit -m "chore(deps): batch dependency updates"
git push -u origin deps/batch-$(date +%Y-%m-%d)
```

After pushing, close the individual dependabot PRs and reference them in the new PR description.

### 5. Trigger Dependabot Commands via PR Comments

Dependabot responds to comments on its own PRs. Available commands:

```
@dependabot rebase           # Rebase onto base branch (fixes BEHIND state)
@dependabot recreate         # Close and reopen with fresh branch (fixes dirty lock)
@dependabot merge            # Approve and merge (if auto-merge not enabled)
@dependabot squash and merge # Squash merge
@dependabot ignore this major version   # Snooze major bumps
@dependabot ignore this minor version   # Snooze minor bumps
@dependabot ignore this patch version   # Stop tracking patch updates
@dependabot close            # Close without merging
```

Post a comment via gh CLI:
```bash
gh pr comment <number> --body "@dependabot rebase"
```

For multiple PRs that are just BEHIND:
```bash
for pr in 101 102 103; do
  gh pr comment $pr --body "@dependabot rebase"
  echo "Triggered rebase on PR #$pr"
done
```

### 6. Direct Merge of Clean PRs

When a PR is CLEAN with all checks passing, merge directly:
```bash
# Merge with squash (preferred for dep updates)
gh pr merge <number> --squash --subject "chore(deps): bump <package> from X to Y"

# Or enable auto-merge so it merges once checks pass
gh pr merge <number> --auto --squash
```

Batch enable auto-merge for all Tier 1 PRs:
```bash
gh pr list --author "app/dependabot" --state open --limit 100 \
  --json number,mergeStateStatus,statusCheckRollup \
  | jq '.[] | select(.mergeStateStatus == "CLEAN") | .number' \
  | xargs -I{} gh pr merge {} --auto --squash
```

### 7. Create Batched PR for Package-lock Safe Grouping

When multiple Tier 1 PRs can be combined (see Step 4):

```bash
gh pr create \
  --title "chore(deps): batch dependency updates" \
  --body "$(cat <<'EOF'
## Batched Dependency Updates

Combines the following dependabot PRs into a single clean update:

- Closes #<n1> — <package> X → Y
- Closes #<n2> — <package> X → Y
- Closes #<n3> — <package> X → Y

### Why batched?
These are all patch/minor updates with green CI. Batching avoids
sequential package-lock regeneration conflicts and reduces PR noise.

### How merged?
Applied `package.json` version bumps from each PR individually,
then ran `npm install` to produce a single clean `package-lock.json`.
EOF
)" \
  --base main \
  --head deps/batch-$(date +%Y-%m-%d)
```

### 8. Handle Major Version Upgrades Individually

For each major version upgrade:

1. Read the PR description (dependabot includes release notes and changelog links)
2. Check the library's CHANGELOG/migration guide
3. Search codebase for usage of changed APIs:
   ```bash
   gh pr view <number> --json body | jq -r '.body'
   grep -r "libraryName" --include="*.ts" packages/
   ```
4. Create a dedicated branch, apply the upgrade, fix breaking changes, add tests
5. Open a PR with a clear description of what changed and why

## Decision Matrix

| Condition | Action |
|-----------|--------|
| CLEAN + all checks pass + patch/minor | Auto-merge or batch |
| CLEAN + all checks pass + major | Individual PR with migration |
| BEHIND + checks pass | `@dependabot rebase`, then merge |
| DIRTY (merge conflict) | `@dependabot recreate` or manual batch |
| Checks failing | Investigate failure, fix or skip |
| Multiple patch/minor + CLEAN | Batch into single PR |

## Tips

- Always check for `package-lock.json` in `gh pr diff <number> --name-only` — if it's there, batching requires the regeneration approach
- After triggering `@dependabot rebase`, wait a few minutes before checking status again
- `gh pr checks <number>` gives a clean view of CI status per PR
- `gh run list --workflow=<name>` can help diagnose recurring CI failures
- Use `gh pr list --search "author:app/dependabot is:open"` for additional filter flexibility
- Dependabot groups can be configured in `.github/dependabot.yml` to pre-group related deps — worth setting up if there are many PRs regularly

## Output

At the end, report:
- PRs merged directly
- PRs batched into combined PR(s) with link
- PRs that need `@dependabot rebase` (triggered, pending re-check)
- PRs skipped with reason (major upgrade, CI failure, etc.)