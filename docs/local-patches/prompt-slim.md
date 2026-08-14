# prompt-slim: drop the full model roster and per-tool summaries from the system prompt

## Problem

Two prompt sections cost ~3.2k tokens every turn while duplicating information
available on demand:

1. `buildModelsSection` renders every auth-configured provider/model
   ("Available models: …", 25 providers / 186 models ≈ 2k tokens). The
   `model_list` tool already enumerates the same registry, and the frozen
   list churns the prompt cache whenever any provider changes.
2. `buildHostVisibleToolsSection` renders one "name — first sentence" line
   per kept host tool (~1.1k tokens). The first sentence is copied from each
   tool's schema description, which the model already receives in `tools`.

## Local change

- Models section keeps "You are running …" and the children default line,
  replaces the roster with one pointer at `model_list`.
- Host-visible tools section lists tool names on one line; division-of-labour
  bullets removed (one referenced the dropped `subagent` tool).

Measured on 2026-08-12 (Anthropic count_tokens, claude-fable-5): system prompt
16,203 → ~13,150 tokens.

## Upstream potential

The roster/cache tension is acknowledged in upstream's own comment on
`RlmPromptOptions.models`. An upstream PR could gate the roster behind an
option (e.g. `models.renderAvailable: false`). Not filed yet.
