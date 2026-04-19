---
name: cc-switch-codex-oauth
description: Use when switching Claude Code to OpenAI GPT models through CC Switch Codex OAuth on macOS. Handles the device-code login flow, writes CC Switch OAuth storage, creates or updates the Claude Codex OAuth provider, changes model mappings such as gpt-5.4, restarts CC Switch, and verifies that Claude is routed through the local proxy.
---

# CC Switch Codex OAuth

Use this skill when the user wants Claude Code to route through `cc-switch` and use OpenAI GPT models via Codex OAuth.

Repo tool:

- `python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py --help`

Default workflow:

1. Start the device-code login:

   ```bash
   python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py start-login
   ```

2. Ask the user to finish browser authorization at `https://auth.openai.com/codex/device`.
3. Complete the login, create or update the Claude provider, and restart `CC Switch`:

   ```bash
   python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py complete-login --model gpt-5.4 --restart-cc-switch
   ```

4. If the user only wants to change the model later:

   ```bash
   python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py set-model --model gpt-5.4 --restart-cc-switch
   ```

5. Inspect current status:

   ```bash
   python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py status
   ```

6. Verify recent routing logs after the user sends a Claude Code request:

   ```bash
   python3 tools/skills/cc-switch-codex-oauth/scripts/cc_switch_codex_oauth.py verify-logs
   ```

Notes:

- This workflow is macOS-specific because it uses `open` and `osascript`.
- It keeps its device-flow files and backups under `tools/skills/cc-switch-codex-oauth/state/`.
- It edits user-local runtime files under `~/.cc-switch` and `~/.claude` only when applying the switch.
- It stores the ChatGPT refresh token locally in `~/.cc-switch/codex_oauth_auth.json`.
- It creates timestamped runtime backups under `tools/skills/cc-switch-codex-oauth/state/backups/`.
- This path uses reverse-engineered OAuth and may carry OpenAI account or ToS risk. State that clearly if the user asks for safety guidance.
