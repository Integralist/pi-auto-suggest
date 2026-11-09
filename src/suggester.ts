import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractConversationContext, type ExtractedContext } from "./context-extractor.ts";
import {
  loadConfig,
  resolveSuggestionModel,
  type AutoSuggestConfig,
} from "./model-resolver.ts";

export type SuggestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

const SYSTEM_PROMPT = [
  "You predict the user's single most likely next prompt in a coding assistant CLI (like Claude Code's SUGGESTION MODE).",
  "Given the recent conversation and any active skill workflow, output ONLY the exact short prompt the user would type next.",
  "",
  "Rules:",
  "1. Keep it concise: 2 to 12 words, under 70 characters, plain imperative text or a /skill:<name> command.",
  "2. If an active <skill> defines ordered steps or phases (e.g., research -> spec -> to-plan -> implement) and the assistant just finished one step, suggest the next step in that workflow (for example: 'create plan from the specification' or '/skill:to-plan').",
  "3. If the assistant asked for approval or confirmation to proceed (e.g. 'proceed with edits?', 'view full diff or proceed?'), suggest the direct confirmation (for example: 'proceed with edits').",
  "4. Output 'NONE' if the task is completely finished with no natural follow-up, or if the next step requires open-ended user domain input you cannot guess.",
  "5. Output ONLY the raw prompt string or 'NONE'. No quotes, no backticks, no prefixes, no explanations.",
].join("\n");

export function buildUserPayload(extracted: ExtractedContext): string {
  const parts: string[] = [];
  if (extracted.activeSkill) {
    parts.push(
      `<active_skill name="${extracted.activeSkill.name}">\n${extracted.activeSkill.content}\n</active_skill>`,
    );
  }
  parts.push(`<recent_conversation>\n${extracted.recentTurns}\n</recent_conversation>`);
  parts.push("Predict the user's next prompt (or NONE):");
  return parts.join("\n\n");
}

export function sanitizeSuggestion(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  let cleaned = raw.trim();
  if (!cleaned) return undefined;

  // Take only the first non-empty line
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  cleaned = firstLine;

  // Strip surrounding quotes or backticks
  while (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith("`") && cleaned.endsWith("`"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  cleaned = cleaned.replace(/^(?:suggestion|next step|prompt):\s*/i, "").trim();

  if (!cleaned) return undefined;
  if (/^none[.!]*$/i.test(cleaned)) return undefined;
  if (cleaned.length > 100) return undefined;

  return cleaned;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

export async function generateSuggestion(
  ctx: ExtensionContext,
  config: AutoSuggestConfig = loadConfig(),
  options: SuggestOptions = {},
): Promise<string | undefined> {
  if (!config.enabled) return undefined;
  if (options.signal?.aborted) return undefined;

  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const extracted = extractConversationContext(branch);
  if (!extracted) return undefined;

  const resolved = resolveSuggestionModel(ctx, config);
  if (!resolved) return undefined;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const timeoutMs = options.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const stream = ctx.modelRegistry.streamSimple(
      resolved.model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserPayload(extracted),
            timestamp: Date.now(),
          },
        ],
        tools: [],
      },
      {
        reasoning: resolved.effort === "off" ? undefined : resolved.effort,
        maxTokens: 64,
        maxRetries: 0,
        toolChoice: "none",
        cacheRetention: "none",
        signal: controller.signal,
      },
    );

    const message = await stream.result();
    if (controller.signal.aborted || options.signal?.aborted) {
      return undefined;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return undefined;
    }

    const rawText = extractAssistantText(message.content);
    return sanitizeSuggestion(rawText);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
