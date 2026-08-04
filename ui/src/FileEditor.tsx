/*
 * Contenu d'un onglet fichier (page Agent) : CodeMirror pour le texte
 * (thème sombre, fond transparent pour hériter du néon — voir App.css),
 * aperçu image, message pour le binaire. `kind: "text"` + `truncated` ⇒
 * édition désactivée (aperçu 2 Mo seulement).
 *
 * Fichiers Markdown : rendu (composant Markdown) PAR DÉFAUT, bascule
 * « Éditer » ↔ « Aperçu » dans une mini-barre locale au contenu — le mode
 * est propre à chaque onglet (état par chemin) et repart en aperçu quand on
 * rouvre le fichier. Le rendu suit le buffer courant : des modifications non
 * sauvegardées restent visibles en repassant en aperçu.
 */
import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import type { Extension } from "@codemirror/state";
import type { FileKind } from "./fsClient";
import { Markdown } from "./Markdown";

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

export interface OpenFileState {
  path: string;
  name: string;
  /** `loading`/`error` sont des états UI locaux, hors du contrat `FileKind` du Rust. */
  kind: FileKind | "loading" | "error";
  content: string;
  base64: string;
  size: number;
  truncated: boolean;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  errorMessage: string | null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(2)} Mo`;
}

function languageExtension(name: string): Extension | null {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "py":
      return python();
    case "rs":
      return rust();
    case "md":
      return markdown();
    case "json":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    default:
      return null;
  }
}

function imageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

export function FileEditorView({
  file,
  onChangeContent,
}: Readonly<{ file: OpenFileState; onChangeContent: (path: string, content: string) => void }>) {
  if (file.kind === "loading") {
    return <p className="empty-hint file-editor__hint">Chargement…</p>;
  }
  if (file.kind === "error") {
    return <div className="file-editor__error">Erreur : {file.errorMessage}</div>;
  }
  if (file.kind === "binary") {
    return <div className="file-editor__binary">Fichier binaire ({formatFileSize(file.size)})</div>;
  }
  if (file.kind === "image") {
    return (
      <div className="file-editor__image-wrap">
        <img className="file-editor__image" src={`data:${imageMime(file.name)};base64,${file.base64}`} alt={file.name} />
      </div>
    );
  }

  if (isMarkdownFile(file.name)) {
    return <MarkdownFileView file={file} onChangeContent={onChangeContent} />;
  }
  return <SourceEditor file={file} onChangeContent={onChangeContent} />;
}

function SourceEditor({
  file,
  onChangeContent,
}: Readonly<{ file: OpenFileState; onChangeContent: (path: string, content: string) => void }>) {
  const extension = languageExtension(file.name);
  return (
    <CodeMirror
      value={file.content}
      theme="dark"
      height="100%"
      extensions={extension ? [extension] : []}
      editable={!file.truncated}
      onChange={(value) => onChangeContent(file.path, value)}
    />
  );
}

function MarkdownFileView({
  file,
  onChangeContent,
}: Readonly<{ file: OpenFileState; onChangeContent: (path: string, content: string) => void }>) {
  // Mode par chemin : rouvrir un onglet (ou en changer) repart en aperçu.
  const [sourceModePaths, setSourceModePaths] = useState<Set<string>>(new Set());
  const sourceMode = sourceModePaths.has(file.path);

  function setMode(source: boolean) {
    setSourceModePaths((prev) => {
      const next = new Set(prev);
      if (source) next.add(file.path);
      else next.delete(file.path);
      return next;
    });
  }

  return (
    <div className="file-editor__md">
      <div className="file-editor__md-bar">
        <button
          type="button"
          className={`btn btn--ghost file-editor__md-toggle${sourceMode ? "" : " file-editor__md-toggle--active"}`}
          onClick={() => setMode(false)}
        >
          Aperçu
        </button>
        <button
          type="button"
          className={`btn btn--ghost file-editor__md-toggle${sourceMode ? " file-editor__md-toggle--active" : ""}`}
          onClick={() => setMode(true)}
          disabled={file.truncated}
          title={file.truncated ? "Fichier tronqué : édition désactivée" : undefined}
        >
          Éditer
        </button>
      </div>
      <div className="file-editor__md-body">
        {sourceMode ? (
          <SourceEditor file={file} onChangeContent={onChangeContent} />
        ) : (
          <div className="file-editor__md-render md">
            <Markdown content={file.content} />
          </div>
        )}
      </div>
    </div>
  );
}
