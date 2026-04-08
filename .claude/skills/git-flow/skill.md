---
name: git-flow
description: Full git workflow for a GitHub issue — move to In Progress, branch, implement, validate, PR, close. Invoke with an issue number, e.g. `/git-flow 42`. Works from any repo under GitHub Project #3 (tg-assistant, tg-assistant-infra, tg-worker-*), or from the personal-assistant-experiments top-level directory if you cd into the target repo first.
user-invocable: true
---

# Git Flow Skill

End-to-end workflow for shipping a GitHub issue: pick up the ticket, branch, implement, validate, open a PR, and close the issue.

**Usage:** `/git-flow <issue-number>` (optionally `/git-flow <issue-number> <owner/repo>`)

This skill is repo-agnostic and identical across every repo under GitHub Project #3. Auto-detect the target repo from the current working directory; do not hardcode repo names.

---

## Step 0 — Resolve the Target Repo

Before any `gh` call, determine which repo the issue belongs to:

```bash
# Prefer an explicit argument if the user passed one.
# Otherwise derive it from the current working directory's git remote.
if [ -n "$EXPLICIT_REPO" ]; then
  REPO="$EXPLICIT_REPO"
elif git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
else
  echo "Not in a git repo. cd into the target repo (e.g. tg-assistant, tg-assistant-infra, tg-worker-echo) or pass <owner/repo> as the second argument." >&2
  exit 1
fi
echo "Target repo: $REPO"
```

All subsequent `gh` commands pass `--repo "$REPO"` explicitly so the skill works the same from inside a repo or from the top-level `personal-assistant-experiments/` directory after a `cd`.

## Constants (shared across every repo in GitHub Project #3)

```
PROJECT_NUMBER : 3
PROJECT_ID     : PVT_kwHOACgNx84BSiDY
STATUS_FIELD_ID: PVTSSF_lAHOACgNx84BSiDYzhACbS4
TODO_ID        : f75ad846
IN_PROGRESS_ID : 47fc9ee4
DONE_ID        : 98236657
OWNER          : qlibin
```

## Tools

Always use `gh` CLI. Never use MCP GitHub tools. Never push directly to `main`.

---

## Step 1 — Read the Issue

```bash
gh issue view <issue-number> --repo "$REPO"
```

Read the full issue body. Understand acceptance criteria before touching any code.

---

## Step 2 — Move Ticket to "In Progress"

The project board spans every repo, so the item lookup must disambiguate by both issue number **and** repository — otherwise an issue #42 in `tg-assistant` could collide with issue #42 in `tg-worker-echo`.

```bash
# Get item ID (filter on both number and repository)
ITEM_ID=$(gh project item-list 3 --owner qlibin --format json \
  | jq -r --arg repo "$REPO" --argjson n <issue-number> \
      '.items[] | select(.content.number == $n and .content.repository == $repo) | .id')

# Move to In Progress
gh project item-edit \
  --project-id PVT_kwHOACgNx84BSiDY \
  --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOACgNx84BSiDYzhACbS4 \
  --single-select-option-id 47fc9ee4
```

---

## Step 3 — Create a Feature Branch

Branch name format: `<type>/issue-<number>-<short-slug>`

- Derive `<type>` from the issue: `feat` for new features, `fix` for bugs, `chore` for maintenance, `docs` for documentation-only.
- Derive `<short-slug>` from the issue title: lowercase, spaces → hyphens, max ~5 words.

```bash
git checkout main
git pull origin main
git checkout -b <type>/issue-<number>-<short-slug>
```

---

## Step 4 — Implement

- Consult the current repo's `CLAUDE.md` for project conventions (TypeScript strict, ESM, naming, test coverage thresholds, package layout). Conventions vary slightly between repos.
- Follow the AAA test pattern; match the repo's coverage thresholds (typically ≥ 85% statements/functions/lines, ≥ 75% branches).
- Never delete snapshot files — update with `npm test -- -u` if shapes change.
- Work incrementally; verify with the repo's test command before final validation.

---

## Step 5 — Update Documentation (if needed)

Review whether any of the following need updating:
- `README.md` — if user-facing behaviour or setup changed
- `CLAUDE.md` — if conventions, commands, or architecture changed
- Inline JSDoc/comments — only where logic is non-obvious

Skip docs if nothing changed that would affect a developer picking up this repo fresh.

---

## Step 6 — Validate

```bash
npm run validate   # build + lint + format + type-check + test
```

Some repos split validation across sub-packages (e.g. `tg-assistant-infra` has both `contracts/` and `infrastructure/`). Run `npm run validate` in every package you touched. Fix any errors before proceeding. Do not skip or suppress checks.

---

## Step 7 — Commit

Stage specific files (never `git add -A` blindly):

```bash
git add <specific files>
git commit -m "<type>(<scope>): <short description>

<optional body>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

Follow conventional commits. `<scope>` is the package or module you touched — each repo uses its own scope vocabulary. Check recent history before picking one:

```bash
git log --oneline -20
```

Common scopes seen across the repos: `webhook`, `feedback`, `common`, `infra`, `contracts`, `worker`, `deps`, `docs`.

---

## Step 8 — Open a PR

Push the branch and create a PR. The `Closes #N` line moves the issue to Done automatically when the PR is merged.

```bash
git push -u origin <branch-name>

gh pr create \
  --repo "$REPO" \
  --title "<type>(<scope>): <short description>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Test plan
- [ ] `npm run validate` passes
- [ ] <any manual verification steps>

Closes #<issue-number>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main \
  --head <branch-name>
```

Return the PR URL to the user.

---

## Step 9 — Done

GitHub auto-closes the issue and moves the project card to Done when the PR is merged (via `Closes #N`).

If you need to move the card manually (e.g. issue closed outside a PR):

```bash
ITEM_ID=$(gh project item-list 3 --owner qlibin --format json \
  | jq -r --arg repo "$REPO" --argjson n <issue-number> \
      '.items[] | select(.content.number == $n and .content.repository == $repo) | .id')

gh project item-edit \
  --project-id PVT_kwHOACgNx84BSiDY \
  --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOACgNx84BSiDYzhACbS4 \
  --single-select-option-id 98236657
```

---

## Quick Reference

| Status      | Option ID  |
|-------------|------------|
| Todo        | f75ad846   |
| In Progress | 47fc9ee4   |
| Done        | 98236657   |

| Repo                 | Typical scopes                          |
|----------------------|-----------------------------------------|
| `tg-assistant`       | `webhook`, `feedback`, `common`, `infra`|
| `tg-assistant-infra` | `infra`, `contracts`                    |
| `tg-worker-echo`     | `worker`, `infra`                       |
