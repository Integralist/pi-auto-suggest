export type ExtractedContext = {
  activeSkill?: {
    name: string;
    content: string;
  };
  recentTurns: string;
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type BranchEntry = {
  type?: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: unknown;
  };
};

const SKILL_TAG_REGEX = /<skill\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/skill>/i;
const MAIN_ARG_KEYS = ["path", "file_path", "command", "task", "steps", "title", "name"] as const;
const ACTIONABLE_REPLY_REGEX =
  /\?|\b(?:next steps?|would you like|proceed|approve|ready for|shall i|should i)\b/i;

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function summarizeToolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const summaries: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as ContentBlock;
    if (block.type !== "toolCall" || typeof block.name !== "string") continue;
    const args = block.arguments ?? {};
    let detail = "";
    for (const key of MAIN_ARG_KEYS) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        detail = val.trim().slice(0, 80);
        break;
      }
      if (Array.isArray(val) && val.length > 0) {
        detail = val
          .filter((v): v is string => typeof v === "string")
          .join(", ")
          .slice(0, 80);
        if (detail) break;
      }
    }
    summaries.push(detail ? `[tool: ${block.name} (${detail})]` : `[tool: ${block.name}]`);
  }
  return summaries;
}

export function shouldTriggerSuggestion(params: {
  hasActiveSkill: boolean;
  lastTurnHadTools: boolean;
  lastAssistantText: string;
}): boolean {
  if (params.hasActiveSkill) return true;
  if (params.lastTurnHadTools) return true;
  if (ACTIONABLE_REPLY_REGEX.test(params.lastAssistantText)) return true;
  return false;
}

export function extractConversationContext(
  branch: readonly unknown[],
  maxChars = 2500,
  maxMessages = 4,
): ExtractedContext | undefined {
  if (!Array.isArray(branch) || branch.length === 0) return undefined;

  let activeSkill: { name: string; content: string } | undefined;
  const turnStrings: string[] = [];
  let lastTurnHadTools = false;
  let lastAssistantText = "";

  for (const rawEntry of branch) {
    const entry = rawEntry as BranchEntry | undefined;
    if (entry?.type !== "message" || !entry.message?.role) continue;
    const { role, stopReason, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant" && (stopReason === "error" || stopReason === "aborted")) {
      continue;
    }

    const rawText = extractTextFromContent(content);
    let cleanedText = rawText;

    if (role === "user") {
      lastTurnHadTools = false;
      const skillMatch = SKILL_TAG_REGEX.exec(rawText);
      if (skillMatch && skillMatch[1] && skillMatch[2]) {
        activeSkill = {
          name: skillMatch[1].trim(),
          content: skillMatch[2].trim().slice(0, 1500),
        };
        cleanedText = rawText.replace(SKILL_TAG_REGEX, `[Invoked skill: ${skillMatch[1].trim()}]`).trim();
      }
    }

    const lines: string[] = [];
    if (cleanedText.trim()) {
      const label = role === "user" ? "User" : "Assistant";
      lines.push(`${label}: ${cleanedText.trim()}`);
    }
    if (role === "assistant") {
      lastAssistantText = cleanedText.trim();
      const tools = summarizeToolCalls(content);
      if (tools.length > 0) {
        lastTurnHadTools = true;
        lines.push(`Assistant tools: ${tools.slice(-6).join(", ")}`);
      }
    }

    if (lines.length > 0) {
      turnStrings.push(lines.join("\n"));
    }
  }

  if (turnStrings.length === 0) return undefined;

  if (
    !shouldTriggerSuggestion({
      hasActiveSkill: Boolean(activeSkill),
      lastTurnHadTools,
      lastAssistantText,
    })
  ) {
    return undefined;
  }

  // Keep at most the last maxMessages (default 4 = last 2 turns) within maxChars
  const recentSlice = turnStrings.slice(-maxMessages);
  const selectedTurns: string[] = [];
  let currentLength = 0;
  for (let i = recentSlice.length - 1; i >= 0; i--) {
    const turn = recentSlice[i]!;
    if (currentLength + turn.length > maxChars && selectedTurns.length > 0) {
      break;
    }
    if (turn.length > maxChars) {
      selectedTurns.unshift(turn.slice(-maxChars));
      break;
    }
    selectedTurns.unshift(turn);
    currentLength += turn.length + 2;
  }

  return {
    ...(activeSkill ? { activeSkill } : {}),
    recentTurns: selectedTurns.join("\n\n"),
  };
}
