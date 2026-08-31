# Codex check — 2026-08-28

## Result

This environment is using Codex CLI: `codex-cli 0.150.1`.

`codex login status` reports **“Logged in using ChatGPT”**. That means tasks run through the Codex CLI are authenticated with the connected ChatGPT account, rather than requiring an `OPENAI_API_KEY`.

## Free-tier usage

Codex is currently included with ChatGPT Free, but its allowance is variable and shared with other agentic features that are available on the account (such as ChatGPT Work, ChatGPT for Excel, and Workspace Agents). Consumption also varies with model, task size, context, reasoning, tools, and whether work is long-running.

To see the actual remaining allowance for this account:

1. In an active Codex CLI session, run `/status`.
2. Or open **Settings / Usage** (the Codex usage dashboard) and inspect the remaining allowance and displayed reset time.
3. If a limit is reached, follow the limit banner. Depending on account eligibility, the choices can include waiting for reset, upgrading, using an available reset, or buying credits.

The repository itself does not currently collect or display Codex usage. Its usage UI supports Claude only, so the account dashboard or `/status` is the authoritative check here.

## Sources

- [OpenAI Help Center: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540/)
