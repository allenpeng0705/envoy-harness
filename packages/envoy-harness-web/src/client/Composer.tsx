import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ChangeEvent,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  KEY_ENTER_COMMAND,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { isPrimaryMod } from "./path-display.js";
import {
  FALLBACK_SLASH_CATALOG,
  filterSlashCatalog,
  type EnterBehavior,
  type SlashCatalogEntry,
} from "./slash-catalog.js";
import {
  fileToDraftAttachment,
  type DraftAttachment,
} from "./attachments.js";

export interface ComposerProps {
  draft: string;
  onDraftChange: (v: string) => void;
  ready: boolean;
  busy: boolean;
  blocked: boolean;
  enterBehavior: EnterBehavior;
  slashCatalog?: ReadonlyArray<SlashCatalogEntry>;
  attachments: ReadonlyArray<DraftAttachment>;
  onAttachmentsChange: (next: DraftAttachment[]) => void;
  attachError?: string | null;
  onAttachError?: (msg: string | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onHint: (text: string) => void;
}

const HINTS = [
  ["Summarize this repo", "Summarize this repository structure and purpose."],
  ["Find TODOs", "Search the workspace for TODO and FIXME comments."],
  ["/compact", "/compact"],
] as const;

function LexicalErrorBoundary({
  children,
}: {
  children: React.ReactElement;
}): JSX.Element {
  return children;
}

function editorText(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

function setEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const p = $createParagraphNode();
    if (text.length > 0) {
      p.append($createTextNode(text));
    }
    root.append(p);
  });
}

function SyncDraftPlugin(props: {
  draft: string;
  onDraftChange: (v: string) => void;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const lastEmitted = useRef(props.draft);
  const applyingExternal = useRef(false);

  useEffect(() => {
    if (props.draft === lastEmitted.current) return;
    applyingExternal.current = true;
    setEditorText(editor, props.draft);
    lastEmitted.current = props.draft;
    applyingExternal.current = false;
  }, [editor, props.draft]);

  const onChange = useCallback(
    (state: EditorState): void => {
      if (applyingExternal.current) return;
      const text = editorText(state);
      lastEmitted.current = text;
      props.onDraftChange(text);
    },
    [props],
  );

  return <OnChangePlugin onChange={onChange} />;
}

function EnterAndPastePlugin(props: {
  enterBehavior: EnterBehavior;
  showPalette: boolean;
  onPaletteEnter: () => boolean;
  onSubmit: () => void;
  onPasteFiles: (files: File[]) => void;
  disabled: boolean;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (props.disabled) return true;
        if (event === null) return false;
        if (props.showPalette) {
          if (!event.shiftKey && props.onPaletteEnter()) {
            event.preventDefault();
            return true;
          }
        }
        const isEnter = !event.shiftKey;
        if (!isEnter) return false;
        if (props.enterBehavior === "mod-enter-send") {
          if (isPrimaryMod(event)) {
            event.preventDefault();
            props.onSubmit();
            return true;
          }
          return false;
        }
        event.preventDefault();
        props.onSubmit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const removePaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (props.disabled || !(event instanceof ClipboardEvent)) return false;
        const items = event.clipboardData?.items;
        if (!items) return false;
        const files: File[] = [];
        for (const item of items) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length === 0) return false;
        event.preventDefault();
        props.onPasteFiles(files);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      removeEnter();
      removePaste();
    };
  }, [editor, props]);

  return null;
}

export function Composer(props: ComposerProps): JSX.Element {
  const [slashIndex, setSlashIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const catalog = props.slashCatalog ?? FALLBACK_SLASH_CATALOG;
  const matches = useMemo(
    () => filterSlashCatalog(catalog, props.draft),
    [catalog, props.draft],
  );
  const showPalette = matches.length > 0;

  const applySlash = (name: string): void => {
    props.onDraftChange(`/${name} `);
    setSlashIndex(0);
    queueMicrotask(() => document.getElementById("eh-composer")?.focus());
  };

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      props.onAttachError?.(null);
      const next = [...props.attachments];
      for (const f of files) {
        try {
          next.push(await fileToDraftAttachment(f));
        } catch (err) {
          props.onAttachError?.(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      props.onAttachmentsChange(next);
    },
    [props],
  );

  const onFilePick = (e: ChangeEvent<HTMLInputElement>): void => {
    const list = e.target.files;
    if (list && list.length > 0) {
      void addFiles([...list]);
    }
    e.target.value = "";
  };

  const placeholder = !props.ready
    ? "Waiting for connection…"
    : props.busy
      ? "Agent is working… Enter queues the next message"
      : props.enterBehavior === "mod-enter-send"
        ? "Message the agent… (⌘/Ctrl+Enter to send, Enter newline)"
        : "Message the agent… (Enter to send, Shift+Enter newline)";

  const canSend =
    props.ready &&
    (props.draft.trim().length > 0 || props.attachments.length > 0);

  const initialConfig = useMemo(
    () => ({
      namespace: "EhComposer",
      onError: (err: Error) => {
        console.error(err);
      },
    }),
    [],
  );

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="composer-hints" aria-label="Quick prompts">
        {HINTS.map(([label, text]) => (
          <button
            key={label}
            type="button"
            className="composer-hint"
            disabled={!props.ready || props.blocked}
            onClick={() => props.onHint(text)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="composer-hint"
          disabled={!props.ready || props.blocked}
          onClick={() => fileInputRef.current?.click()}
        >
          Attach…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={onFilePick}
        />
      </div>

      {props.attachments.length > 0 ? (
        <ul className="attach-chips" aria-label="Attachments">
          {props.attachments.map((a) => (
            <li key={a.id} className="attach-chip">
              <span className="mono">
                {a.kind === "image" ? "img" : "file"}:{a.name}
              </span>
              <button
                type="button"
                className="attach-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() =>
                  props.onAttachmentsChange(
                    props.attachments.filter((x) => x.id !== a.id),
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {props.attachError ? (
        <p className="attach-error" role="alert">
          {props.attachError}
        </p>
      ) : null}

      {showPalette ? (
        <ul className="slash-palette" role="listbox" aria-label="Slash commands">
          {matches.map((m, i) => (
            <li key={m.name}>
              <button
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className={
                  i === slashIndex ? "slash-item active" : "slash-item"
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySlash(m.name);
                }}
              >
                <span className="slash-name mono">/{m.name}</span>
                <span className="slash-desc">{m.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className={`composer-editor${props.blocked || !props.ready ? " disabled" : ""}`}
        onKeyDown={(e) => {
          if (!showPalette) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSlashIndex((i) => (i + 1) % matches.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSlashIndex(
              (i) => (i - 1 + matches.length) % matches.length,
            );
            return;
          }
          if (e.key === "Tab") {
            const pick = matches[slashIndex] ?? matches[0];
            if (pick !== undefined) {
              e.preventDefault();
              applySlash(pick.name);
            }
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            props.onDraftChange("");
          }
        }}
      >
        <LexicalComposer initialConfig={initialConfig}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                id="eh-composer"
                className="composer-editable"
                aria-label="Message the agent"
                aria-placeholder={placeholder}
                placeholder={
                  <div className="composer-placeholder">{placeholder}</div>
                }
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <SyncDraftPlugin
            draft={props.draft}
            onDraftChange={(v) => {
              props.onDraftChange(v);
              setSlashIndex(0);
            }}
          />
          <EnterAndPastePlugin
            enterBehavior={props.enterBehavior}
            showPalette={showPalette}
            onPaletteEnter={() => {
              const pick = matches[slashIndex] ?? matches[0];
              if (pick === undefined) return false;
              applySlash(pick.name);
              return true;
            }}
            onSubmit={props.onSubmit}
            onPasteFiles={(files) => {
              void addFiles(files);
            }}
            disabled={!props.ready || props.blocked}
          />
        </LexicalComposer>
      </div>

      {props.busy ? (
        <div className="composer-actions">
          {canSend ? (
            <button
              type="button"
              onClick={() => props.onSubmit()}
              disabled={!props.ready}
            >
              Queue
            </button>
          ) : null}
          <button
            type="button"
            className="primary stop"
            onClick={props.onCancel}
            title="Stop (Esc)"
          >
            Stop
          </button>
        </div>
      ) : (
        <button
          type="submit"
          className="primary"
          disabled={!canSend || props.blocked}
        >
          Send
        </button>
      )}
    </form>
  );
}
