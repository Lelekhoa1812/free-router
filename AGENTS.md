# Repository rules

This file applies to everyone working in `free-router`, human or automated. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Ownership

[`.github/CODEOWNERS`](.github/CODEOWNERS) is the review-routing source of truth; [MAINTAINERS.md](MAINTAINERS.md) maps each area to its reviewers. Do not merge a change that crosses an area without that owner's review. Update CODEOWNERS and MAINTAINERS.md in the same pull request when ownership changes.

## Pull requests

- Title: `<type>(<scope>): <summary>`, at most 72 characters, no trailing period.
- Do not add `type:`, `area:`, `size:` or `ci:` labels by hand; the workflows derive them.
- Keep the PR a draft until the description, checks and Agent disclosure are complete.
- Fill the Agent disclosure from what actually ran. Write `unknown` rather than guessing a model, effort setting or source commit.
- Run `pnpm typecheck`, `pnpm test` and `pnpm build`, and record anything not verified.

## Contracts

- A `/v1` request or response change updates `docs/API_CONTRACTS.md` and its tests in the same change.
- Record release-gate status in `docs/IMPLEMENTATION_STATUS.md`; do not claim live provider or Jev behaviour without evidence.
- Never commit client keys, provider keys, cookies or environment values.

## Framework

This repository runs a Next.js version with breaking changes. Read the relevant guide under `node_modules/next/dist/docs/` before editing framework code. The generated block below is maintained by `next dev`; leave it in place.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
