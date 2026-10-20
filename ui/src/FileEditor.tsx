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
 *
 * Fichiers HTML : le source, et une barre qui dit que c'en est un + « Ouvrir
 * dans le navigateur » (T-090). L'app n'a PAS d'aperçu rendu pour le HTML —
 * un `srcdoc` casserait CSS, images et navigation entre pages, c'est-à-dire
 * qu'il mentirait sur la page. Le vrai rendu passe donc par le navigateur du
 * poste, via `open_external` (mêmes règles par extension que le menu de
 * l'arborescence). L'ancien silence laissait croire qu'ouvrir l'onglet ouvrait
 * la page.
 *
 * Fichiers binaires : même mécanique, avec « Ouvrir avec l'application
 * système » (T-106) — un PDF du projet, sans aperçu ici, s'arrêtait sinon au
 * message « Fichier binaire » sans aucune issue.
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
import { findAppForExtension, openExternal, readApps } from "./appsAdmin";
import { Markdown } from "./Markdown";

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function isHtmlFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
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
    return <BinaryFileView file={file} />;
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
  if (isHtmlFile(file.name)) {
    return <HtmlFileView file={file} onChangeContent={onChangeContent} />;
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

/**
 * Bouton d'ouverture externe partagé par les panneaux HTML et binaire : même
 * mécanique (`readApps` + `findAppForExtension` + `openExternal`) que
 * l'ouverture depuis l'arborescence. L'échec s'affiche à côté du bouton — un
 * clic qui ne fait rien en silence serait exactement le mensonge que ce
 * composant vient corriger (T-090, T-106).
 */
function OuvrirExterne({ file, label }: Readonly<{ file: OpenFileState; label: string }>) {
  const [openError, setOpenError] = useState<string | null>(null);

  function ouvrir() {
    setOpenError(null);
    readApps()
      .then((apps) => openExternal(file.path, findAppForExtension(apps, file.name)?.command))
      .catch((err: unknown) => {
        setOpenError(err instanceof Error && err.message ? err.message : String(err));
      });
  }

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={ouvrir}>
        {label}
      </button>
      {openError && <span className="file-editor__error">Erreur : {openError}</span>}
    </>
  );
}

function BinaryFileView({ file }: Readonly<{ file: OpenFileState }>) {
  // Sans aperçu possible ici, l'ouverture système est la seule issue — un PDF
  // du projet s'arrêtait sinon net sur ce message, sans aucun bouton (T-106).
  return (
    <div className="file-editor__binary">
      <div>Fichier binaire ({formatFileSize(file.size)})</div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <OuvrirExterne file={file} label="Ouvrir avec l'application système" />
      </div>
    </div>
  );
}

function HtmlFileView({
  file,
  onChangeContent,
}: Readonly<{ file: OpenFileState; onChangeContent: (path: string, content: string) => void }>) {
  return (
    <div className="file-editor__md">
      <div className="file-editor__md-bar">
        <span className="file-editor__hint">Fichier HTML — l'app n'a pas d'aperçu rendu, le vrai rendu passe par le navigateur.</span>
        <OuvrirExterne file={file} label="Ouvrir dans le navigateur" />
      </div>
      <div className="file-editor__md-body">
        <SourceEditor file={file} onChangeContent={onChangeContent} />
      </div>
    </div>
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
