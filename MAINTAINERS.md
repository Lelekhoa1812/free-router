# Maintainers and area ownership

Review routing is automatic. [`.github/CODEOWNERS`](.github/CODEOWNERS) lists the reviewers for each path, and GitHub requests them when a pull request touches that area. This table explains the split; update both files together.

| Area | Paths | Reviewers |
| --- | --- | --- |
| API contracts, Decisions and Jev | `src/app/v1/`, `src/lib/jev.ts`, `src/lib/models/` | @Lelekhoa1812 @kinqsradio |
| Auth, keys and admin | `src/lib/auth/`, `src/app/api/`, `src/lib/audit.ts` | @Lelekhoa1812 @kinqsradio |
| Providers, storage and admission | `src/lib/providers/`, `src/lib/db.ts`, `src/lib/redis.ts` | @Lelekhoa1812 @kinqsradio |
| Dashboard and setup | `src/components/`, `src/app/setup/`, `src/app/page.tsx` | @Lelekhoa1812 @kinqsradio |
| Docs, workflows and release | `docs/`, `.github/`, `package.json`, lockfile | @Lelekhoa1812 @kinqsradio |

Both current accounts have write access. GitHub skips the author, so a pull request opened from one account requests the other. Replace the reviewer column and the matching CODEOWNERS entries when an area gets a dedicated owner.

## Changing ownership

Update `.github/CODEOWNERS` and this table in the same pull request. A code owner must have write access to the repository; do not list an account that cannot review.

To block merges until a code owner approves, enable **Require review from Code Owners** in the `main` branch protection rule. Without it, CODEOWNERS still requests the review but does not enforce it.

## Review expectations

The owner reviews contract impact, tests and the stated gaps. CI must pass before merge, and the `PR triage / Title format` check must be green when branch protection requires it. If the owner is unavailable, leave the pull request in `status: needs-review` rather than merging without review.
