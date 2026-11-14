# Codex and Nemotron troubleshooting

Use the HTTP Responses provider with `wire_api = "responses"` and the pinned model `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`. The desktop app and CLI share the provider configuration in `~/.codex/config.toml`. Keep `env_key` as the variable name `FREEROUTER_API_KEY`; never put the actual key in that field or commit it.

## A turn ends with a promise of more work

In observed desktop rollouts the gateway returned successful responses, but the final assistant message was a progress sentence such as “Let me fix the test script” with no native tool call. Codex treated that as the end of the turn. A plain-text instruction alone did not fix it: the synthetic six-check probe ended after only two successful checks, and a second run ended after one. A local protocol probe also showed that setting a message's `phase` to `commentary` alone did not cause this installed client to request another completion.

For the narrowly scoped Codex/Nemotron request shape documented in [API_CONTRACTS.md](API_CONTRACTS.md), private progress and finish functions give the Chat model an explicit turn protocol. The gateway continues only a declared private progress action; it does not infer unfinished work from English text. Caller actions still execute in Codex. Required upstream tool selection prevents unmarked progress text from silently becoming a final answer. Deliberate final answers, blockers, permission questions and user stops remain valid outcomes. Repeated progress has a bounded failure path rather than an endless continuation loop.

Run the bounded synthetic acceptance probe against a running local production build:

```sh
pnpm start --port 3107
# In another terminal with FREEROUTER_API_KEY already set:
pnpm smoke:codex-agent
```

For production, set `FREEROUTER_BASE_URL=https://free-router-olive.vercel.app` before the same probe. It uses six sequential synthetic checks, deliberately returns one protocol error, and verifies the tool-issued final receipt. It never executes business MCP tools or shell commands. It fails immediately if a progress-only final answer arrives before all checks pass. This is a bounded model acceptance test; it cannot guarantee arbitrary tasks or unlimited-session reliability.

## A turn says its goal budget was exhausted

Goal token budgets and model context windows are separate controls. In an earlier affected chat, a 200,000-token goal budget was exceeded by a single request reporting roughly 503,000 input tokens; the app then inserted an explicit instruction to stop and summarize. Large tool declarations and conversation history count as provider input again on subsequent requests. Changing the model context window does not remove a goal budget.

Inspect the current goal state before treating a budget message as a model failure. Remove or raise an unwanted goal budget through the user's goal controls, preserving any deliberate budget. Old notices can remain in the chat's history after the goal is cleared; they are not evidence of a current limit. Never falsify provider usage or disable gateway quota accounting to work around a client budget.

## Verification limits

Read the dated evidence and open gates in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). A passing synthetic workflow does not certify the affected application's read/write MCP workflows, all provider bindings, or a long-running autonomous task.
