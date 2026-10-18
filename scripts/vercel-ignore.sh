#!/bin/bash
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
# In the month to 2026-10-17, 108 of 295 production builds were for commits
# that touched no deployed code (tests, docs, markdown, the MCP/SDK packages),
# and build minutes were a fifth of the Vercel bill.

if git log -1 --pretty=%B | grep -qF "[skip ci]"; then
  echo "skip: [skip ci] commit"
  exit 0
fi

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
# No previous deploy, or it is outside the shallow clone: build to be safe.
if [ -z "$prev" ] || ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  echo "build: previous deploy commit unavailable"
  exit 1
fi

if git diff --quiet "$prev" HEAD -- . \
  ':(exclude)test' ':(exclude)docs' ':(exclude).github' \
  ':(exclude)mcp' ':(exclude)sdk' ':(exclude)skill' \
  ':(exclude)examples' ':(exclude)integrations' ':(exclude)*.md'; then
  echo "skip: no deployed files changed since $prev"
  exit 0
fi

echo "build: deployed files changed"
exit 1
