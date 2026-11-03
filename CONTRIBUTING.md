# Contributing

FreeRouter's public surface spans `/v1` contracts, stored Responses, provider routing, quota accounting and the dashboard. A change should be reviewable without opening the whole repository. These rules keep the history and the review queue readable.

## Branch names

`<type>/<summary>`, lowercase kebab-case, using the same types as PR titles.

- `fix/decisions-unnamed-questions`
- `feat/model-certification-workflow`
- `docs/provider-routing-notes`

One branch per change. Do not put agent, vendor or model names in a branch, and do not reuse a merged branch.

## Issue titles

Use the templates: `[bug]: <symptom>` or `[feature]: <capability>`. For a blank issue, start with the kind of work, for example `[docs]:` or `[chore]:`.

Security-sensitive defects must not be filed publicly. Contact the maintainer privately through GitHub.

## PR titles

```
<type>(<scope>): <summary>
```

- `type` is required and must be one of `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`, `build`, `revert`.
- `scope` is optional but recommended: `decisions`, `chat`, `responses`, `models`, `auth`, `providers`, `storage`, `dashboard`, `docs`, `ci`.
- `summary` is imperative, starts with a letter, has no trailing period, and the whole title is at most 72 characters.
- A breaking contract change uses `!` before the colon and a `BREAKING CHANGE:` footer in the body.

Examples:

```
fix(decisions): accept unnamed questions
feat(auth): require same-origin admin mutations
docs: record the decisions error envelope
```

The PR title becomes the squash commit subject, so it is the line that stays in history. Edit it before merging; do not correct it afterwards with an empty commit. Intermediate commits on the branch may be free-form because the squash discards them.

`.github/workflows/pr-triage.yml` fails the `PR triage / Title format` check until the title matches. Mark that check required in branch protection if a bad title must block merging.

## Labels

Labels are the review queue. Do not add `type:`, `area:`, `size:` or `ci:` labels by hand: `.github/workflows/pr-triage.yml` and `.github/workflows/pr-status.yml` set them from the title, changed paths, diff size and CI result.

| Group | Values | Set by |
| --- | --- | --- |
| `type:` | `feature`, `bug`, `docs`, `test`, `refactor`, `chore`, `performance`, `ci` | PR title prefix |
| `area:` | `decisions`, `chat`, `responses`, `models`, `auth`, `providers`, `storage`, `dashboard`, `docs`, `ci` | Changed paths |
| `size:` | `small`, `medium`, `large` | Diff line count |
| `ci:` | `passed`, `failed` | CI workflow result |
| `status:` (PR) | `draft`, `ci-running`, `needs-review`, `changes-requested`, `approved` | PR lifecycle |
| `status:` (issue) | `needs-triage`, `triaged`, `blocked` | Templates and manual triage |
| `priority:` | `high`, `medium`, `low` | Manual triage on issues |

The review queue is:

```
is:pr is:open label:"status: needs-review"
```

A PR enters `status: needs-review` only after CI passes and the PR is not a draft. New commits replace it with `status: ci-running`; a review replaces it with `status: approved` or `status: changes-requested`.

## Ownership and review

[`.github/CODEOWNERS`](.github/CODEOWNERS) requests a review automatically when a pull request touches an area; [MAINTAINERS.md](MAINTAINERS.md) maps areas to the current reviewers. Update both files in the same change when ownership moves. Do not merge an area change without its owner's review; if the owner is unavailable, leave the pull request in `status: needs-review`.

## Checks

Run what CI runs:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Record the commands and their output in the PR template. A passing suite does not prove a provider integration works; state what you did not verify.

## Disclosure

Fill in the Agent disclosure section from what actually ran. Write `unknown` rather than guessing a model, effort setting or source commit. Reused code or text needs its link, commit and licence; if the licence is incompatible, do not copy it.

## Review

Keep the PR a draft until the first push is ready for comment. Mark it ready when the description, tests and disclosure are complete. A reviewer needs the contract impact and the gaps, not a narration of the diff.
