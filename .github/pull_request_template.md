<!--
Guidance lives in HTML comments and stays hidden in the rendered PR.
Delete a section that does not apply; do not leave it blank.
-->

## What changed

<!-- The correction in a paragraph. Describe the behaviour after merge, not the order you wrote the code. -->

## Why

<!-- The defect, trigger or gap this closes. Link the issue when one exists. A green test suite shows the change works; it does not show the change is needed. -->

## Contract and data impact

<!-- Which contract moves: /v1 request or response shape, error codes, stored Mongo documents, Redis keys, admin endpoints, environment configuration, provider routing. Write "None" only when nothing observable changes. Name any index, migration or existing row that needs attention. -->

## Verification

<!-- Commands you actually ran and what they printed. If the evidence predates the final head, say which commit it belongs to. -->

| Check | Result |
| --- | --- |
| `pnpm typecheck` | |
| `pnpm test` | |
| `pnpm build` | |

<!-- Live or manual evidence: endpoint, input, observed response, environment. Say plainly what it does not cover. -->

## Not verified

<!-- The edge of the evidence: paths not exercised, provider behaviour left unconfirmed, SDK or deployment differences. "None" is only accurate when you have covered everything the diff touches. -->

## Rollout and rollback

<!-- Operator steps this needs: new environment variables, index creation, binding or cache resets. How to back it out: revert, toggle, or restore stored state. "Revert the commit; no stored state changes" is a complete answer when true. -->

## Agent disclosure

<!-- Fill from what actually ran. Write "unknown" rather than guessing. Delete this section only when no agent or automated assistant took part. -->

- **Tools:**
- **Models:** provider, exact model IDs, effort setting when the host exposes it
- **Human role:** what the person decided, reviewed or rejected — not only "approved"
- **External sources:** link, commit and licence for each source whose code or text was reused; otherwise "none"

## Review path

<!-- Only for a diff a reviewer cannot hold in their head. Order the reading: core behaviour first, then wiring, then mechanical edits. Trace one tricky input through the old and new code when that explains the difference. Omit for a small change. -->
