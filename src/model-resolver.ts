import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AutomaticEffort = Exclude<ModelThinkingLevel, "max">;

export type AutoSuggestConfig = {
  enabled: boolean;
  model: string;
};

export type ResolvedSuggestionModel = {
  model: Model<Api>;
  effort: AutomaticEffort;
  source: "override" | "cheapest" | "session";
};

const EFFORT_PREFERENCE: readonly AutomaticEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const FAST_MODEL_PATTERNS = [
  /haiku/i,
  /flash/i,
  /mini/i,
  /nano/i,
  /luna/i,
  /small/i,
  /fast/i,
  /lite/i,
];

export function getDefaultConfigPath(): string {
  try {
    return join(getAgentDir(), "auto-suggest.json");
  } catch {
    return join(homedir(), ".pi", "agent", "auto-suggest.json");
  }
}

export function loadConfig(path: string = getDefaultConfigPath()): AutoSuggestConfig {
  if (!path || !existsSync(path)) {
    return { enabled: true, model: "auto" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "auto",
    };
  } catch {
    return { enabled: true, model: "auto" };
  }
}

export function saveConfig(
  config: AutoSuggestConfig,
  path: string = getDefaultConfigPath(),
): void {
  if (!path) return;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort persistence
  }
}

export function isPhysicalModel(model: Model<Api> | undefined): model is Model<Api> {
  return Boolean(model && model.api && model.api !== "pi-virtual");
}

function isUsableModel(ctx: ExtensionContext, model: Model<Api> | undefined): model is Model<Api> {
  if (!isPhysicalModel(model)) return false;
  if (typeof ctx.modelRegistry?.hasConfiguredAuth === "function") {
    try {
      return ctx.modelRegistry.hasConfiguredAuth(model);
    } catch {
      return false;
    }
  }
  return true;
}

export function pickLowestEffort(model: Model<Api>): AutomaticEffort {
  try {
    const supported = getSupportedThinkingLevels(model);
    for (const candidate of EFFORT_PREFERENCE) {
      if (supported.includes(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to low/off if metadata is incomplete
  }
  return model.reasoning ? "low" : "off";
}

function scoreCandidateModel(model: Model<Api>): number {
  const label = `${model.provider}/${model.id} ${model.name ?? ""}`;
  const isFastFamily = FAST_MODEL_PATTERNS.some((re) => re.test(label));
  const inputCost = Number.isFinite(model.cost?.input) ? model.cost.input : 5;
  const outputCost = Number.isFinite(model.cost?.output) ? model.cost.output : 15;
  const totalCost = inputCost + outputCost;
  // Fast families get a strong priority boost, then ordered by token cost.
  return (isFastFamily ? 0 : 1000) + totalCost;
}

function resolveOverrideModel(
  ctx: ExtensionContext,
  overrideSpec: string,
): Model<Api> | undefined {
  const trimmed = overrideSpec.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    const provider = trimmed.slice(0, slashIdx);
    const id = trimmed.slice(slashIdx + 1);
    const direct = ctx.modelRegistry?.find?.(provider, id);
    if (isUsableModel(ctx, direct)) return direct;
  }

  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  const lower = trimmed.toLowerCase();
  const match = available.find(
    (m) =>
      isUsableModel(ctx, m) &&
      (`${m.provider}/${m.id}`.toLowerCase() === lower || m.id.toLowerCase() === lower),
  );
  return match;
}

function resolveCheapestEnabledModel(ctx: ExtensionContext): Model<Api> | undefined {
  const scoped = (ctx.scopedModels ?? [])
    .map((entry) => entry?.model)
    .filter((m): m is Model<Api> => isUsableModel(ctx, m));

  const pool =
    scoped.length > 0
      ? scoped
      : (ctx.modelRegistry?.getAvailable?.() ?? []).filter((m) => isUsableModel(ctx, m));

  if (pool.length === 0) return undefined;

  const sorted = [...pool].sort((a, b) => scoreCandidateModel(a) - scoreCandidateModel(b));
  return sorted[0];
}

function resolveSessionPhysicalModel(ctx: ExtensionContext): Model<Api> | undefined {
  if (isUsableModel(ctx, ctx.model)) {
    return ctx.model;
  }

  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | {
          type?: string;
          message?: {
            role?: string;
            provider?: string;
            model?: string;
            stopReason?: string;
            api?: string;
          };
        }
      | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const msg = entry.message;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
    if (msg.api === "pi-virtual" || !msg.provider || !msg.model) continue;
    const found = ctx.modelRegistry?.find?.(msg.provider, msg.model);
    if (isUsableModel(ctx, found)) {
      return found;
    }
  }
  return undefined;
}

export function resolveSuggestionModel(
  ctx: ExtensionContext,
  config: AutoSuggestConfig = loadConfig(),
): ResolvedSuggestionModel | undefined {
  // Tier 1: Pinned user override
  if (config.model && config.model.toLowerCase() !== "auto") {
    const override = resolveOverrideModel(ctx, config.model);
    if (override) {
      return {
        model: override,
        effort: pickLowestEffort(override),
        source: "override",
      };
    }
  }

  // Tier 2: Cheapest/fastest enabled model from scopedModels or available models
  const cheapest = resolveCheapestEnabledModel(ctx);
  if (cheapest) {
    return {
      model: cheapest,
      effort: pickLowestEffort(cheapest),
      source: "cheapest",
    };
  }

  // Tier 3: Active session physical model (or last assistant turn's physical model)
  const sessionModel = resolveSessionPhysicalModel(ctx);
  if (sessionModel) {
    return {
      model: sessionModel,
      effort: pickLowestEffort(sessionModel),
      source: "session",
    };
  }

  return undefined;
}
