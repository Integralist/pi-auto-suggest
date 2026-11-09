import {
  CustomEditor,
  type CustomEditorOptions,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorComponent,
  type EditorTheme,
  type TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface SuggestionController {
  getSuggestion(): string | undefined;
  setSuggestion(text: string | undefined): void;
  clearSuggestion(): void;
  requestRender(): void;
  onUserActivity?: () => void;
}

export type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;

const WRAPPED_EDITOR_FACTORY = Symbol.for("pi-auto-suggest.wrappedEditorFactory");
const WRAPPED_EDITOR_INSTANCE = Symbol.for("pi-auto-suggest.wrappedEditorInstance");

type MarkedFactory = EditorFactory & {
  [WRAPPED_EDITOR_FACTORY]?: boolean;
};

type ExtendedEditor = EditorComponent & {
  [WRAPPED_EDITOR_INSTANCE]?: boolean;
  isShowingAutocomplete?: () => boolean;
  getPaddingX?: () => number;
};

const EMPTY_CURSOR_TOKENS = [
  {
    token: "\x1b_pi:fc\x07 \x1b_pi:/fc\x07",
    wrap: (c: string) => `\x1b_pi:fc\x07${c}\x1b_pi:/fc\x07`,
  },
  {
    token: "\x1b[7m \x1b[0m",
    wrap: (c: string) => `\x1b[7m${c}\x1b[0m`,
  },
  {
    token: "\x1b[7m \x1b[27m",
    wrap: (c: string) => `\x1b[7m${c}\x1b[27m`,
  },
];

export const SUGGESTION_PREFIX = "suggested: ";

function styleFaded(text: string, uiContext?: ExtensionUIContext): string {
  const activeTheme = uiContext?.theme as
    | {
        style?: (t: string, opts: { fg?: string; dim?: boolean }) => string;
        fg?: (color: string, t: string) => string;
      }
    | undefined;
  if (activeTheme && typeof activeTheme.style === "function") {
    return activeTheme.style(text, { fg: "dim", dim: true });
  }
  if (activeTheme && typeof activeTheme.fg === "function") {
    return `\x1b[2m${activeTheme.fg("dim", text)}\x1b[22m`;
  }
  return `\x1b[2m\x1b[90m${text}\x1b[22m\x1b[39m`;
}

export function renderGhostSuggestionLine(
  lines: string[],
  editor: ExtendedEditor,
  controller: SuggestionController,
  uiContext?: ExtensionUIContext,
): string[] {
  const suggestion = controller.getSuggestion();
  if (!suggestion) return lines;
  if (editor.getText() !== "") return lines;
  if (editor.isShowingAutocomplete?.()) return lines;
  if (lines.length < 3 || lines[1] === undefined) return lines;

  const line = lines[1];
  const matched = EMPTY_CURSOR_TOKENS.find((entry) => line.includes(entry.token));
  if (!matched) return lines;

  const cursorIdx = line.indexOf(matched.token);
  const before = line.slice(0, cursorIdx);
  const after = line.slice(cursorIdx + matched.token.length);
  const paddingSpaces = visibleWidth(after);
  const paddingX = typeof editor.getPaddingX === "function" ? editor.getPaddingX() : 0;
  // +1 column because the cursor cell itself holds the first character
  const availableWidth = Math.max(0, 1 + paddingSpaces - paddingX);

  if (availableWidth <= 0) return lines;

  const fullGhostText = `${SUGGESTION_PREFIX}${suggestion}`;
  const displaySuggestion =
    visibleWidth(fullGhostText) <= availableWidth
      ? fullGhostText
      : truncateToWidth(fullGhostText, availableWidth, "");

  if (!displaySuggestion) return lines;

  const firstChar = displaySuggestion[0]!;
  const restChars = displaySuggestion.slice(1);
  const cursorCell = matched.wrap(styleFaded(firstChar, uiContext));
  const styledRest = restChars ? styleFaded(restChars, uiContext) : "";
  const remainingSpaces = Math.max(0, paddingSpaces - visibleWidth(restChars));
  lines[1] = before + cursorCell + styledRest + " ".repeat(remainingSpaces);

  return lines;
}

function isAcceptKey(data: string, keybindings?: KeybindingsManager): boolean {
  if (data === "\t" || data === "\x1b[C") return true;
  if (matchesKey(data, "tab") || matchesKey(data, "right")) return true;
  if (keybindings?.matches?.(data, "tui.input.tab")) return true;
  if (keybindings?.matches?.(data, "tui.editor.cursorRight")) return true;
  return false;
}

function isEscapeKey(data: string, keybindings?: KeybindingsManager): boolean {
  if (data === "\x1b") return true;
  if (matchesKey(data, "escape")) return true;
  if (keybindings?.matches?.(data, "app.interrupt")) return true;
  return false;
}

export function attachAutoSuggestToEditor(
  editor: EditorComponent,
  controller: SuggestionController,
  uiContext?: ExtensionUIContext,
  keybindings?: KeybindingsManager,
): EditorComponent {
  const extEditor = editor as ExtendedEditor;
  if (extEditor[WRAPPED_EDITOR_INSTANCE]) {
    return extEditor;
  }

  const origRender = extEditor.render.bind(extEditor);
  const origHandleInput = extEditor.handleInput.bind(extEditor);
  const origSetText = extEditor.setText.bind(extEditor);

  extEditor.render = (width: number): string[] => {
    const lines = origRender(width);
    return renderGhostSuggestionLine(lines, extEditor, controller, uiContext);
  };

  extEditor.setText = (text: string): void => {
    if (text !== "" && controller.getSuggestion()) {
      controller.clearSuggestion();
    }
    origSetText(text);
  };

  extEditor.handleInput = (data: string): void => {
    const suggestion = controller.getSuggestion();
    const isEmpty = extEditor.getText() === "";
    const autocompleteOpen = Boolean(extEditor.isShowingAutocomplete?.());

    if (suggestion && isEmpty && !autocompleteOpen) {
      if (isAcceptKey(data, keybindings)) {
        controller.clearSuggestion();
        extEditor.setText(suggestion);
        controller.requestRender();
        return;
      }
      if (isEscapeKey(data, keybindings)) {
        controller.clearSuggestion();
        controller.requestRender();
        return;
      }
    }

    origHandleInput(data);

    if (extEditor.getText() !== "") {
      controller.onUserActivity?.();
      if (controller.getSuggestion()) {
        controller.clearSuggestion();
      }
    }
  };

  extEditor[WRAPPED_EDITOR_INSTANCE] = true;
  return extEditor;
}

export class AutoSuggestEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    controller: SuggestionController,
    uiContext?: ExtensionUIContext,
    options?: CustomEditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    attachAutoSuggestToEditor(this, controller, uiContext, keybindings);
  }
}

function createWrappedEditorFactory(
  baseFactory: EditorFactory | undefined,
  controller: SuggestionController,
  uiContext: ExtensionUIContext,
  onTuiReady: (tui: TUI) => void,
): MarkedFactory {
  const factory: MarkedFactory = (tui, theme, keybindings) => {
    onTuiReady(tui);
    const baseEditor = baseFactory
      ? baseFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings);
    return attachAutoSuggestToEditor(baseEditor, controller, uiContext, keybindings);
  };
  factory[WRAPPED_EDITOR_FACTORY] = true;
  return factory;
}

export function installAutoSuggestEditor(
  ctx: ExtensionContext,
  controller: SuggestionController,
  onTuiReady: (tui: TUI) => void = () => {},
): void {
  if (!ctx.hasUI || typeof ctx.ui?.setEditorComponent !== "function") {
    return;
  }

  const wrapCurrentIfNeeded = (): void => {
    const currentFactory =
      typeof ctx.ui.getEditorComponent === "function"
        ? (ctx.ui.getEditorComponent() as MarkedFactory | undefined)
        : undefined;
    if (currentFactory?.[WRAPPED_EDITOR_FACTORY]) {
      return;
    }
    const wrapped = createWrappedEditorFactory(currentFactory, controller, ctx.ui, onTuiReady);
    ctx.ui.setEditorComponent(wrapped);
  };

  wrapCurrentIfNeeded();

  queueMicrotask(() => {
    wrapCurrentIfNeeded();
  });

  setTimeout(() => {
    wrapCurrentIfNeeded();
  }, 0);
}
