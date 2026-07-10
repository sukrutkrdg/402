# Contributing

Issues and PRs are welcome.

- **Bugs / ideas**: open a GitHub issue with steps to reproduce (or the use case).
- **PRs**: keep them focused; run `npm run typecheck` and `npx vitest run` before submitting.
- **New services**: follow the pattern in `src/lib/services.ts` — a handler must validate its
  inputs, never call a paid upstream on the free path (`noFreeTier`), and return `checkedAt`.
- **Security**: for anything sensitive, please contact the maintainer privately instead of a
  public issue.
