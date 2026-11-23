import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  loadConfig,
  pickLowestEffort,
  resolveSuggestionModel,
  saveConfig,
} from "../src/model-resolver.ts";
import { extractConversationContext } from "../src/context-extractor.ts";
import { generateSuggestion, sanitizeSuggestion } from "../src/suggester.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  AutoSuggestEditor,
  attachAutoSuggestToEditor,
  installAutoSuggestEditor,
  type SuggestionController,
} from "../src/editor.ts";
import autoSuggest from "../src/index.ts";

function fakeModel(overrides: Partial<Model<Api>> & { provider: string; id: string }): Model<Api> {
  return {
    name: overrides.id,
    api: "openai-completions",
    baseUrl: "https://example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as Model<Api>;
}

describe("config persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-auto-suggest-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns default config when file does not exist", () => {
    const cfg = loadConfig(join(tempDir, "missing.json"));
    expect(cfg).toEqual({ enabled: true, model: "auto" });
  });

  it("saves and reloads config", () => {
    const file = join(tempDir, "auto-suggest.json");
    saveConfig({ enabled: false, model: "github-copilot/gpt-6-luna" }, file);
    expect(loadConfig(file)).toEqual({
      enabled: false,
      model: "github-copilot/gpt-6-luna",
    });
  });
});

describe("resolveSuggestionModel (3-tier fallback)", () => {
  const frontier = fakeModel({
    provider: "anthropic",
    id: "claude-opus-4-6",
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
  });
  const cheapFast = fakeModel({
    provider: "github-copilot",
    id: "gpt-6-luna",
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  });
  const haiku = fakeModel({
    provider: "amazon-bedrock",
    id: "global.anthropic.claude-haiku-5-5",
    cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 },
  });
  const virtualAuto = fakeModel({
    provider: "pi-auto-model",
    id: "auto",
    api: "pi-virtual" as Api,
  });

  it("Tier 1: uses pinned user override when valid and authenticated", () => {
    const ctx: any = {
      model: frontier,
      scopedModels: [{ model: frontier }, { model: cheapFast }],
      modelRegistry: {
        find: (p: string, id: string) =>
          p === "amazon-bedrock" && id === haiku.id ? haiku : undefined,
        getAvailable: () => [frontier, cheapFast, haiku],
        hasConfiguredAuth: () => true,
      },
      sessionManager: { getBranch: () => [] },
    };

    const resolved = resolveSuggestionModel(ctx, {
      enabled: true,
      model: "amazon-bedrock/global.anthropic.claude-haiku-5-5",
    });
    expect(resolved?.source).toBe("override");
    expect(resolved?.model.id).toBe(haiku.id);
  });

  it("Tier 2: picks cheapest/fastest enabled model from scopedModels when model is 'auto'", () => {
    const ctx: any = {
      model: virtualAuto,
      scopedModels: [{ model: virtualAuto }, { model: frontier }, { model: cheapFast }],
      modelRegistry: {
        find: () => undefined,
        getAvailable: () => [frontier, cheapFast],
        hasConfiguredAuth: () => true,
      },
      sessionManager: { getBranch: () => [] },
    };

    const resolved = resolveSuggestionModel(ctx, { enabled: true, model: "auto" });
    expect(resolved?.source).toBe("cheapest");
    expect(resolved?.model.id).toBe("gpt-6-luna");
    expect(["off", "minimal", "low"]).toContain(resolved?.effort);
  });

  it("Tier 3: falls back to active session physical model (or last assistant turn physical model) when no scoped/available list", () => {
    const ctx: any = {
      model: virtualAuto,
      scopedModels: [],
      modelRegistry: {
        find: (p: string, id: string) =>
          p === frontier.provider && id === frontier.id ? frontier : undefined,
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              provider: frontier.provider,
              model: frontier.id,
              stopReason: "stop",
              content: [{ type: "text", text: "Spec is ready." }],
            },
          },
        ],
      },
    };

    const resolved = resolveSuggestionModel(ctx, { enabled: true, model: "auto" });
    expect(resolved?.source).toBe("session");
    expect(resolved?.model.id).toBe(frontier.id);
    expect(pickLowestEffort(frontier)).toBeDefined();
  });
});

describe("extractConversationContext", () => {
  it("extracts active <skill> block and recent user/assistant turns", () => {
    const branch = [
      {
        type: "message",
        message: {
          role: "user",
          content:
            '<skill name="architect" location="/skills/architect/SKILL.md">\nStep 1: Research\nStep 2: Write spec with to-spec\nStep 3: Create implementation plan with to-plan\n</skill>\n\nDesign the caching service',
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "toolCall", name: "write", arguments: { path: "docs/spec.md" } },
            {
              type: "text",
              text: "I have written and reviewed docs/spec.md. Ready for the implementation plan.",
            },
          ],
        },
      },
    ];

    const extracted = extractConversationContext(branch);
    expect(extracted).toBeDefined();
    expect(extracted?.activeSkill?.name).toBe("architect");
    expect(extracted?.activeSkill?.content).toContain("to-plan");
    expect(extracted?.recentTurns).toContain("docs/spec.md");
    expect(extracted?.recentTurns).toContain("Ready for the implementation plan");
  });

  it("returns undefined when branch has no usable messages", () => {
    expect(extractConversationContext([])).toBeUndefined();
  });

  it("skips plain Q&A turns with no active skill, no tool calls, and no follow-up question", () => {
    const plainQaBranch = [
      {
        type: "message",
        message: { role: "user", content: "What does HTTP 204 mean?" },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "HTTP 204 means No Content." }],
        },
      },
    ];
    expect(extractConversationContext(plainQaBranch)).toBeUndefined();
  });

  it("triggers when assistant reply ends with a question or Next Step even without tools/skills", () => {
    const actionableBranch = [
      {
        type: "message",
        message: { role: "user", content: "Check the config" },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: "### Next Step\nWould you like me to proceed with edits?",
            },
          ],
        },
      },
    ];
    const extracted = extractConversationContext(actionableBranch);
    expect(extracted).toBeDefined();
    expect(extracted?.recentTurns).toContain("proceed with edits?");
  });

  it("bounds context to the last 2 turns (4 messages) and 2500 chars by default", () => {
    const manyTurns = [
      { type: "message", message: { role: "user", content: "Turn 1 user old" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Turn 1 assistant old" }],
        },
      },
      { type: "message", message: { role: "user", content: "Turn 2 user kept" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Turn 2 assistant kept" }],
        },
      },
      { type: "message", message: { role: "user", content: "Turn 3 user kept" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
            { type: "text", text: "Turn 3 assistant kept" },
          ],
        },
      },
    ];
    const extracted = extractConversationContext(manyTurns);
    expect(extracted).toBeDefined();
    expect(extracted?.recentTurns).not.toContain("Turn 1");
    expect(extracted?.recentTurns).toContain("Turn 2");
    expect(extracted?.recentTurns).toContain("Turn 3");
  });
});

describe("sanitizeSuggestion & generateSuggestion", () => {
  it("cleans valid suggestions and rejects NONE or noisy output", () => {
    expect(sanitizeSuggestion('"create plan from the specification"')).toBe(
      "create plan from the specification",
    );
    expect(sanitizeSuggestion("`run /skill:to-plan on docs/spec.md`")).toBe(
      "run /skill:to-plan on docs/spec.md",
    );
    expect(sanitizeSuggestion("NONE")).toBeUndefined();
    expect(sanitizeSuggestion("none.")).toBeUndefined();
    expect(sanitizeSuggestion("")).toBeUndefined();
  });

  it("calls streamSimple with skill-aware context and returns cleaned suggestion", async () => {
    const cheapFast = fakeModel({ provider: "github-copilot", id: "gpt-6-luna" });
    let capturedPrompt = "";

    const ctx: any = {
      model: cheapFast,
      scopedModels: [{ model: cheapFast }],
      modelRegistry: {
        find: () => cheapFast,
        getAvailable: () => [cheapFast],
        hasConfiguredAuth: () => true,
        streamSimple: (_model: any, context: any) => {
          capturedPrompt = JSON.stringify(context);
          return {
            result: async () => ({
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "create plan from the specification" }],
            }),
          };
        },
      },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "user",
              content:
                '<skill name="architect" location="/skills/architect/SKILL.md">After spec review, run to-plan.</skill>\n\nWrite the spec',
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Spec review complete." }],
            },
          },
        ],
      },
    };

    const suggestion = await generateSuggestion(ctx, { enabled: true, model: "auto" });
    expect(suggestion).toBe("create plan from the specification");
    expect(capturedPrompt).toContain("architect");
    expect(capturedPrompt).toContain("Spec review complete");
  });

  function createSuggestionContext(streamSimple: (...args: any[]) => any): any {
    const model = fakeModel({ provider: "github-copilot", id: "gpt-6-luna" });
    return {
      model,
      scopedModels: [{ model }],
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        streamSimple,
      },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "user",
              content: '<skill name="architect">Continue the workflow.</skill>',
            },
          },
        ],
      },
    };
  }

  it("reports when no authenticated model is available", async () => {
    const onError = vi.fn();
    const ctx = createSuggestionContext(() => ({
      result: async () => ({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "unused" }],
      }),
    }));
    ctx.modelRegistry.hasConfiguredAuth = () => false;

    expect(await generateSuggestion(ctx, { enabled: true, model: "auto" }, { onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("No authenticated model is available for auto-suggest.");
  });

  it("reports provider errors but not a valid NONE response", async () => {
    const onError = vi.fn();
    const ctx = createSuggestionContext(() => ({
      result: async () => ({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Expired AWS SSO session",
        content: [],
      }),
    }));

    expect(await generateSuggestion(ctx, { enabled: true, model: "auto" }, { onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("Expired AWS SSO session");

    ctx.modelRegistry.streamSimple = () => ({
      result: async () => ({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "NONE" }],
      }),
    });
    onError.mockClear();
    expect(await generateSuggestion(ctx, { enabled: true, model: "auto" }, { onError })).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports thrown request errors", async () => {
    const onError = vi.fn();
    const ctx = createSuggestionContext(() => ({
      result: async () => {
        throw new Error("AWS SSO credentials expired");
      },
    }));

    expect(await generateSuggestion(ctx, { enabled: true, model: "auto" }, { onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("AWS SSO credentials expired");
  });

  it("reports request timeouts but not user cancellation", async () => {
    const onError = vi.fn();
    const timeoutContext = createSuggestionContext((_model: any, _context: any, options: any) => ({
      result: () =>
        new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => resolve({ role: "assistant", stopReason: "aborted", content: [] }),
            { once: true },
          );
        }),
    }));

    expect(
      await generateSuggestion(timeoutContext, { enabled: true, model: "auto" }, { onError, timeoutMs: 5 }),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("Auto-suggest request timed out after 5ms");

    const controller = new AbortController();
    const cancelContext = createSuggestionContext((_model: any, _context: any, options: any) => ({
      result: () =>
        new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => resolve({ role: "assistant", stopReason: "aborted", content: [] }),
            { once: true },
          );
        }),
    }));
    const pending = generateSuggestion(
      cancelContext,
      { enabled: true, model: "auto" },
      { onError, signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("allocates sufficient maxTokens headroom for reasoning and non-reasoning models", async () => {
    const capturedMaxTokens: number[] = [];

    const reasoningCtx = createSuggestionContext((_model: any, _context: any, options: any) => {
      capturedMaxTokens.push(options.maxTokens);
      return {
        result: async () => ({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "run tests" }],
        }),
      };
    });
    expect(await generateSuggestion(reasoningCtx, { enabled: true, model: "auto" })).toBe("run tests");

    const nonReasoningModel = fakeModel({
      provider: "github-copilot",
      id: "gpt-4o-mini",
      reasoning: false,
    });
    const nonReasoningCtx = createSuggestionContext((_model: any, _context: any, options: any) => {
      capturedMaxTokens.push(options.maxTokens);
      return {
        result: async () => ({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "run tests" }],
        }),
      };
    });
    nonReasoningCtx.model = nonReasoningModel;
    nonReasoningCtx.scopedModels = [{ model: nonReasoningModel }];
    nonReasoningCtx.modelRegistry.find = () => nonReasoningModel;
    nonReasoningCtx.modelRegistry.getAvailable = () => [nonReasoningModel];

    expect(await generateSuggestion(nonReasoningCtx, { enabled: true, model: "auto" })).toBe(
      "run tests",
    );
    expect(capturedMaxTokens).toEqual([1024, 128]);
  });

  it("drops truncated suggestions when stopReason is length without reporting an error", async () => {
    const onError = vi.fn();
    const ctx = createSuggestionContext(() => ({
      result: async () => ({
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "tackle both pi-clean" }],
      }),
    }));

    expect(
      await generateSuggestion(ctx, { enabled: true, model: "auto" }, { onError }),
    ).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("AutoSuggestEditor ghost text & Tab/Right-Arrow acceptance", () => {
  function createTestSetup(initialSuggestion?: string, paddingX = 0) {
    let currentSuggestion = initialSuggestion;
    let renderCount = 0;
    const controller: SuggestionController = {
      getSuggestion: () => currentSuggestion,
      setSuggestion: (val) => {
        currentSuggestion = val;
      },
      clearSuggestion: () => {
        currentSuggestion = undefined;
      },
      requestRender: () => {
        renderCount++;
      },
    };

    const tui: any = {
      terminal: { rows: 24, columns: 80 },
      requestRender: () => {
        renderCount++;
      },
    };
    const theme: any = { borderColor: (s: string) => s, selectList: {} };
    const kb: any = {
      matches: (data: string, id: string) => {
        if (id === "tui.input.tab" && data === "\t") return true;
        if (id === "tui.editor.cursorRight" && data === "\x1b[C") return true;
        if (id === "app.interrupt" && data === "\x1b") return true;
        return false;
      },
      getKeys: () => [],
    };
    const mockUI: any = {
      theme: {
        fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
      },
    };

    const editor = new AutoSuggestEditor(tui, theme, kb, controller, mockUI, { paddingX });
    editor.focused = true;
    return { editor, controller, getRenderCount: () => renderCount };
  }

  it("renders faded 'suggested: <text>' at column 0 (no leading space) preserving terminal width", () => {
    const { editor } = createTestSetup("create plan from the specification");
    const lines = editor.render(80);
    const plain = stripTerminalSequences(lines[1]!);
    expect(plain.startsWith("suggested: create plan from the specification")).toBe(true);
    expect(visibleWidth(lines[1]!)).toBe(80);
  });

  it("truncates placeholder text cleanly on narrow terminal width", () => {
    const { editor } = createTestSetup("create plan from the specification");
    const lines = editor.render(25);
    const plain = stripTerminalSequences(lines[1]!);
    expect(visibleWidth(lines[1]!)).toBe(25);
    expect(plain.startsWith("suggested: create plan")).toBe(true);
  });

  it("does not render placeholder when editor already has text", () => {
    const { editor } = createTestSetup("create plan from the specification");
    editor.setText("hello");
    const lines = editor.render(80);
    expect(lines[1]).not.toContain("create plan from the specification");
  });

  it("accepts placeholder into editor when pressing Tab on empty prompt", () => {
    const { editor, controller } = createTestSetup("create plan from the specification");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("create plan from the specification");
    expect(controller.getSuggestion()).toBeUndefined();
  });

  it("accepts placeholder into editor when pressing Right Arrow on empty prompt", () => {
    const { editor, controller } = createTestSetup("run /skill:to-plan");
    editor.handleInput("\x1b[C");
    expect(editor.getText()).toBe("run /skill:to-plan");
    expect(controller.getSuggestion()).toBeUndefined();
  });

  it("clears placeholder and inserts character when typing normally", () => {
    const { editor, controller } = createTestSetup("create plan from the specification");
    editor.handleInput("a");
    expect(editor.getText()).toBe("a");
    expect(controller.getSuggestion()).toBeUndefined();
  });

  it("dismisses placeholder on Escape without aborting when suggestion is active", () => {
    const { editor, controller } = createTestSetup("create plan from the specification");
    let escaped = false;
    editor.onEscape = () => {
      escaped = true;
    };
    editor.handleInput("\x1b");
    expect(controller.getSuggestion()).toBeUndefined();
    expect(escaped).toBe(false);
  });
});

describe("extension lifecycle integration", () => {
  it("populates suggestion on agent_settled and clears on input", async () => {
    const handlers = new Map<string, Function>();
    const commands = new Map<string, { handler: Function }>();
    let installedFactory: Function | undefined;

    const pi: any = {
      on: (event: string, handler: Function) => {
        handlers.set(event, handler);
      },
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.set(name, opts);
      },
    };

    const tempDir = mkdtempSync(join(tmpdir(), "pi-auto-suggest-ext-"));
    try {
      autoSuggest(pi, { configPath: join(tempDir, "auto-suggest.json"), debounceMs: 20 });

      const cheapFast = fakeModel({ provider: "github-copilot", id: "gpt-6-luna" });
      const ctx: any = {
        hasUI: true,
        mode: "tui",
        model: cheapFast,
        scopedModels: [{ model: cheapFast }],
        isIdle: () => true,
        hasPendingMessages: () => false,
        ui: {
          theme: { fg: (_c: string, t: string) => t },
          getEditorText: () => "",
          getEditorComponent: () => installedFactory,
          setEditorComponent: (f: Function) => {
            installedFactory = f;
          },
          notify: vi.fn(),
        },
        modelRegistry: {
          find: () => cheapFast,
          getAvailable: () => [cheapFast],
          hasConfiguredAuth: () => true,
          streamSimple: () => ({
            result: async () => ({
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "create plan from the specification" }],
            }),
          }),
        },
        sessionManager: {
          getBranch: () => [
            {
              type: "message",
              message: { role: "user", content: "Write the spec" },
            },
            {
              type: "message",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [
                  { type: "toolCall", name: "write", arguments: { path: "docs/spec.md" } },
                  { type: "text", text: "Spec finished. Ready for next step?" },
                ],
              },
            },
          ],
        },
      };

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      expect(installedFactory).toBeTypeOf("function");

      const tui: any = { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() };
      const theme: any = { borderColor: (s: string) => s, selectList: {} };
      const kb: any = { matches: () => false, getKeys: () => [] };
      const editorInstance = installedFactory!(tui, theme, kb);

      editorInstance.focused = true;
      await handlers.get("agent_settled")?.({ aborted: false }, ctx);
      const rendered = editorInstance.render(80);
      expect(stripTerminalSequences(rendered[1]!)).toContain(
        "suggested: create plan from the specification",
      );

      await handlers.get("input")?.({ text: "something else" }, ctx);
      const afterInput = editorInstance.render(80);
      expect(stripTerminalSequences(afterInput[1]!)).not.toContain("create plan");

      // Simulate another extension (like pi-skill-argument-hints) overwriting setEditorComponent after session_start
      ctx.ui.setEditorComponent((t: any, th: any, k: any) => new CustomEditor(t, th, k));
      await handlers.get("resources_discover")?.({ reason: "startup" }, ctx);

      const rewrappedEditor = installedFactory!(tui, theme, kb);
      rewrappedEditor.focused = true;

      // Test /auto-suggest subcommands (no notify banner on test)
      const cmd = commands.get("auto-suggest")!;
      ctx.ui.notify.mockClear();
      await cmd.handler("test run /skill:to-plan", ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(stripTerminalSequences(rewrappedEditor.render(80)[1]!)).toContain(
        "suggested: run /skill:to-plan",
      );

      // Tab accepts ONLY the text after 'suggested: ' into the prompt bar
      rewrappedEditor.handleInput("\t");
      expect(rewrappedEditor.getText()).toBe("run /skill:to-plan");
      rewrappedEditor.setText("");

      await cmd.handler("test", ctx);
      expect(stripTerminalSequences(rewrappedEditor.render(80)[1]!)).toContain(
        "suggested: create plan from the specification",
      );

      await cmd.handler("clear", ctx);
      ctx.ui.notify.mockClear();
      ctx.modelRegistry.streamSimple = () => ({
        result: async () => ({
          role: "assistant",
          stopReason: "error",
          errorMessage: "Expired AWS SSO session",
          content: [],
        }),
      });
      await cmd.handler("test", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Auto-suggest failed: Expired AWS SSO session",
        "warning",
      );
      expect(stripTerminalSequences(rewrappedEditor.render(80)[1]!)).toContain(
        "suggested: Fallback (no model suggestion returned):",
      );

      await cmd.handler("off", ctx);
      expect(rewrappedEditor.render(80)[1]).not.toContain("create plan from the specification");

      await cmd.handler("on", ctx);
      await cmd.handler("model github-copilot/gpt-6-luna", ctx);
      await cmd.handler("status", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("configured=github-copilot/gpt-6-luna"),
        "info",
      );

      // Verify debounce cancels LLM call if user types before debounce expires
      let streamCalls = 0;
      ctx.modelRegistry.streamSimple = () => {
        streamCalls++;
        return {
          result: async () => ({
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "should not be called" }],
          }),
        };
      };
      const settledPromise = handlers.get("agent_settled")?.({ aborted: false }, ctx);
      await handlers.get("input")?.({ text: "typing fast" }, ctx);
      await settledPromise;
      expect(streamCalls).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
