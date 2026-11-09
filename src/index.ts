import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { installAutoSuggestEditor, type SuggestionController } from "./editor.ts";
import {
  getDefaultConfigPath,
  loadConfig,
  resolveSuggestionModel,
  saveConfig,
  type AutoSuggestConfig,
} from "./model-resolver.ts";
import { generateSuggestion } from "./suggester.ts";

export {
  AutoSuggestEditor,
  attachAutoSuggestToEditor,
  installAutoSuggestEditor,
  renderGhostSuggestionLine,
  type SuggestionController,
} from "./editor.ts";
export {
  extractConversationContext,
  shouldTriggerSuggestion,
  type ExtractedContext,
} from "./context-extractor.ts";
export {
  getDefaultConfigPath,
  loadConfig,
  pickLowestEffort,
  resolveSuggestionModel,
  saveConfig,
  type AutoSuggestConfig,
  type ResolvedSuggestionModel,
} from "./model-resolver.ts";
export {
  buildUserPayload,
  generateSuggestion,
  sanitizeSuggestion,
  type SuggestOptions,
} from "./suggester.ts";

export default function autoSuggest(
  pi: ExtensionAPI,
  options: { configPath?: string; debounceMs?: number } = {},
): void {
  const configPath = options.configPath ?? getDefaultConfigPath();
  const debounceMs = options.debounceMs ?? 500;
  let config: AutoSuggestConfig = loadConfig(configPath);
  let currentSuggestion: string | undefined;
  let activeTui: TUI | undefined;
  let inFlightAbort: AbortController | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceResolve: (() => void) | undefined;
  let generation = 0;

  const cancelInFlight = (): void => {
    generation++;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (debounceResolve) {
      const resolve = debounceResolve;
      debounceResolve = undefined;
      resolve();
    }
    if (inFlightAbort) {
      inFlightAbort.abort();
      inFlightAbort = undefined;
    }
  };

  const controller: SuggestionController = {
    getSuggestion: () => currentSuggestion,
    setSuggestion: (text: string | undefined) => {
      currentSuggestion = text;
      activeTui?.requestRender();
    },
    clearSuggestion: () => {
      if (currentSuggestion !== undefined) {
        currentSuggestion = undefined;
        activeTui?.requestRender();
      }
    },
    requestRender: () => {
      activeTui?.requestRender();
    },
    onUserActivity: () => {
      cancelInFlight();
    },
  };

  const triggerBackgroundSuggestion = async (ctx: ExtensionContext): Promise<void> => {
    cancelInFlight();
    config = loadConfig(configPath);
    if (!config.enabled) return;

    const editorText = ctx.ui?.getEditorText?.() ?? "";
    if (editorText.trim().length > 0) return;

    const myGeneration = generation;
    const abortController = new AbortController();
    inFlightAbort = abortController;

    const suggestion = await generateSuggestion(ctx, config, {
      signal: abortController.signal,
    });

    if (myGeneration !== generation || abortController.signal.aborted) {
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return;
    }
    const latestEditorText = ctx.ui?.getEditorText?.() ?? "";
    if (latestEditorText.trim().length > 0) {
      return;
    }

    if (suggestion) {
      installAutoSuggestEditor(ctx, controller, (tui) => {
        activeTui = tui;
      });
      controller.setSuggestion(suggestion);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    cancelInFlight();
    controller.clearSuggestion();
    config = loadConfig(configPath);
    installAutoSuggestEditor(ctx, controller, (tui) => {
      activeTui = tui;
    });
  });

  pi.on("resources_discover", (_event, ctx) => {
    installAutoSuggestEditor(ctx, controller, (tui) => {
      activeTui = tui;
    });
  });

  pi.on("input", () => {
    cancelInFlight();
    controller.clearSuggestion();
  });

  pi.on("before_agent_start", () => {
    cancelInFlight();
    controller.clearSuggestion();
  });

  pi.on("agent_start", () => {
    cancelInFlight();
    controller.clearSuggestion();
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) return;
    if (!ctx.hasUI) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    cancelInFlight();
    const myGeneration = generation;

    if (debounceMs > 0) {
      await new Promise<void>((resolve) => {
        debounceResolve = resolve;
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          debounceResolve = undefined;
          resolve();
        }, debounceMs);
      });
    }

    if (myGeneration !== generation) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    await triggerBackgroundSuggestion(ctx);
  });

  pi.on("session_shutdown", () => {
    cancelInFlight();
    controller.clearSuggestion();
    activeTui = undefined;
  });

  pi.registerCommand("auto-suggest", {
    description:
      "Configure or inspect prompt auto-suggestions (status, on, off, toggle, model <provider/id|auto>, test [text])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const [sub = "status", ...rest] = trimmed.split(/\s+/);
      const restText = rest.join(" ").trim();
      config = loadConfig(configPath);

      switch (sub.toLowerCase()) {
        case "":
        case "status": {
          const resolved = resolveSuggestionModel(ctx, config);
          const modelInfo = resolved
            ? `${resolved.model.provider}/${resolved.model.id} (${resolved.effort}, ${resolved.source})`
            : "none available";
          const current = currentSuggestion ? `"${currentSuggestion}"` : "none";
          ctx.ui.notify(
            `auto-suggest: ${config.enabled ? "ON" : "OFF"} | configured=${config.model} | resolved=${modelInfo} | suggestion=${current}`,
            "info",
          );
          return;
        }
        case "on": {
          config.enabled = true;
          saveConfig(config, configPath);
          ctx.ui.notify("auto-suggest enabled", "info");
          return;
        }
        case "off": {
          config.enabled = false;
          saveConfig(config, configPath);
          cancelInFlight();
          controller.clearSuggestion();
          ctx.ui.notify("auto-suggest disabled", "info");
          return;
        }
        case "toggle": {
          config.enabled = !config.enabled;
          saveConfig(config, configPath);
          if (!config.enabled) {
            cancelInFlight();
            controller.clearSuggestion();
          }
          ctx.ui.notify(`auto-suggest ${config.enabled ? "enabled" : "disabled"}`, "info");
          return;
        }
        case "model": {
          if (!restText) {
            ctx.ui.notify(
              `Current model setting: ${config.model}. Usage: /auto-suggest model <provider/id | auto>`,
              "info",
            );
            return;
          }
          config.model = restText;
          saveConfig(config, configPath);
          const resolved = resolveSuggestionModel(ctx, config);
          ctx.ui.notify(
            resolved
              ? `auto-suggest model set to ${config.model} (resolved: ${resolved.model.provider}/${resolved.model.id} [${resolved.source}])`
              : `auto-suggest model set to ${config.model} (warning: no matching authenticated model currently found)`,
            resolved ? "info" : "warning",
          );
          return;
        }
        case "test": {
          installAutoSuggestEditor(ctx, controller, (tui) => {
            activeTui = tui;
          });
          if (restText) {
            controller.setSuggestion(restText);
          } else {
            await triggerBackgroundSuggestion(ctx);
            if (!currentSuggestion) {
              controller.setSuggestion("create plan from the specification");
            }
          }
          return;
        }
        case "clear": {
          cancelInFlight();
          controller.clearSuggestion();
          ctx.ui.notify("Cleared current suggestion", "info");
          return;
        }
        default: {
          ctx.ui.notify(
            "Usage: /auto-suggest [status | on | off | toggle | model <provider/id|auto> | test [text] | clear]",
            "warning",
          );
        }
      }
    },
  });
}
