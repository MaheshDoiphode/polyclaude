# Polyclaude

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with any LLM provider — not just Anthropic.

Polyclaude is a transparent proxy that sits between Claude Code and your preferred model provider. It routes requests through [LiteLLM](https://github.com/BerriAI/litellm) so you can use GitHub Copilot, Google Gemini, Antigravity (Google's internal cloudcode API), or Anthropic models — all through Claude Code's familiar interface.

## Why?

Claude Code normally only talks to Anthropic's API. If you have access to models through other providers (a Copilot subscription, a Gemini API key, an Antigravity-enabled Google account), you couldn't use them with Claude Code — until now.

## Features

- **Multi-provider support** — GitHub Copilot, Google Gemini, Google Antigravity, and Anthropic
- **Transparent to Claude Code** — patches settings automatically so Claude Code talks to the local proxy
- **Automatic model fallbacks** — Claude Code's required model names (e.g. `claude-sonnet-4`) are silently mapped to an available provider when no Anthropic key is set
- **OAuth authentication** — GitHub device code flow, Google OAuth 2.0 with PKCE and auto-refresh, Anthropic API key entry
- **Dynamic model discovery** — fetches available models from each provider at runtime
- **Antigravity interceptor** — wraps/unwraps Google's cloudcode envelope format, with schema sanitization for cross-provider compatibility

## Supported Providers

| Provider | Namespace | Auth |
|---|---|---|
| GitHub Copilot | `copilot/<model>` | Device code OAuth |
| Google Gemini | `gemini/<model>` | Google OAuth 2.0 + PKCE |
| Google Antigravity | `antigravity/<model>` | Google OAuth 2.0 + PKCE |
| Anthropic | `claude-*` (native) | API key |

## Installation

```bash
npm install -g polyclaude
```

Requires [LiteLLM](https://docs.litellm.ai/docs/) (`pip install litellm`) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`).

## Quick Start

### 1. Login to your provider(s)

```bash
polyclaude login
```

This walks you through authentication for each provider. You can set up one or all of them.

### 2. Run Claude Code with a specific model

```bash
# Use a Copilot model
polyclaude --model copilot/claude-sonnet-4

# Use a Gemini model
polyclaude --model gemini/gemini-2.5-pro

# Use an Antigravity model
polyclaude --model antigravity/gemini-3.1-pro-low
polyclaude --model antigravity/claude-opus-4-6-thinking

# Default — just run with whatever's available
polyclaude
```

Polyclaude starts the LiteLLM proxy in the background, patches Claude Code's settings to point at it, launches `claude`, and cleans up when you exit.

## Commands

| Command | Description |
|---|---|
| `polyclaude` | Default — sync config, start proxy, launch Claude Code |
| `polyclaude setup` | Sync model configs without launching Claude |
| `polyclaude login` | Authenticate with providers |
| `polyclaude list` | List all available models |
| `polyclaude start` | Run the LiteLLM proxy in the foreground |

All other arguments are passed through to `claude` directly.

## How It Works

```
Claude Code  →  LiteLLM proxy (port 4000)  →  Provider API
                     ↓
              Antigravity interceptor (port 51122)  →  cloudcode-pa.googleapis.com
```

1. **Config sync** — discovers available models from each authenticated provider and generates a LiteLLM config
2. **Proxy startup** — starts LiteLLM on port 4000 with the generated config, plus the Antigravity interceptor on port 51122
3. **Settings patch** — rewrites `~/.claude/settings.json` to point `ANTHROPIC_BASE_URL` at the local proxy
4. **Claude launch** — starts `claude` CLI which now routes all API calls through the proxy
5. **Cleanup** — restores settings on exit

## Available Antigravity Models

These models are available through Google's Antigravity/cloudcode API:

- `gemini-3.1-pro-low`, `gemini-3.1-pro-high`
- `gemini-3-pro-low`, `gemini-3-pro-high`
- `gemini-3-flash`, `gemini-3.1-flash-image`
- `gemini-2.5-pro`, `gemini-2.5-flash`
- `claude-sonnet-4-6`, `claude-opus-4-6-thinking`
- `gpt-oss-120b-medium`

## Configuration

Config files are stored in `~/.polyclaude/` and `~/.litellm/`:

- `~/.litellm/copilot-config.yaml` — LiteLLM model routing config (auto-generated)
- `~/.litellm/.env` — API keys and tokens
- `~/.claude/settings.json` — patched by polyclaude to point at the local proxy

## License

ISC
