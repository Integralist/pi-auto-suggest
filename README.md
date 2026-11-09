# pi-auto-suggest

A Pi extension that suggests your next prompt as muted ghost text in the prompt
bar after an assistant turn settles, inspired by Claude Code's SUGGESTION MODE.

## Features

- **Skill-aware next steps:** Inspects the recent conversation and any active
  `<skill>` workflow in the session branch (such as `architect`, `to-spec`, or
  `to-plan`) to predict the natural next prompt.
- **3-tier model resolution:**
  1. **Pinned override:** Uses `model` from `~/.pi/agent/auto-suggest.json` when
     configured via `/auto-suggest model <provider/id>`.
  2. **Cheapest fast enabled model:** Automatically selects the lowest-cost fast
     model (`haiku`, `flash`, `mini`, `nano`, `luna`) from your enabled
     `scopedModels` (or available authenticated models) at the lowest supported
     thinking effort.
  3. **Active session model fallback:** Falls back to the physical model used in
     the current session at its lowest supported thinking effort.
- **Composable ghost-text editor:** Wraps `ctx.ui.getEditorComponent()` so it
  coexists with other editor extensions (such as `pi-skill-argument-hints` and
  `pi-prompt-history`).

## Controls

When the prompt bar is empty and a ghost suggestion is visible:

- **Tab** or **Right Arrow:** Accept the suggestion into the prompt bar for
  editing or submission.
- **Escape:** Dismiss the suggestion.
- **Any other key:** Type normally (clears the suggestion).

## Commands

```txt
/auto-suggest                  Show current status, resolved model, and active suggestion
/auto-suggest on | off         Enable or disable background suggestions
/auto-suggest toggle           Toggle background suggestions
/auto-suggest model <target>   Pin a provider/model or reset with 'auto'
/auto-suggest test [text]      Preview ghost text immediately or trigger a live suggestion
/auto-suggest clear            Clear the current suggestion
```

## Development

```bash
make install     # Install dependencies
make verify      # Run unit tests and TypeScript typecheck
make try         # Launch Pi with only this extension loaded (isolated)
make try-all     # Launch Pi with this extension loaded alongside your config
```
