/*
 * Rendu Markdown (GFM) en éléments React pour les transcriptions (blocs de
 * texte de l'ASSISTANT uniquement — voir AgentPage.tsx/ChatPage.tsx, les
 * messages utilisateur restent en texte brut pre-wrap). `react-markdown` +
 * `remark-gfm`, sans `rehype-raw` : le HTML brut éventuellement présent dans
 * le texte n'est donc PAS interprété (échappé tel quel), aucun
 * `dangerouslySetInnerHTML` nulle part.
 *
 * Liens : `target="_blank"` est inopérant en webview Tauri (pas d'onglet à
 * ouvrir) — on intercepte le clic et on route vers `open_external` (déjà
 * utilisé par FileTree.tsx pour ouvrir fichiers/apps externes ; `xdg-open`
 * en repli sous Linux accepte aussi bien un chemin qu'une URL).
 *
 * Références de fichiers cliquables (page Agent, voir AgentPage.tsx) : si
 * `onFileRef` est fourni, un `code` INLINE (pas un bloc — distingué via
 * `node.position` : une portée mono-ligne, un bloc de code fence toujours
 * au moins deux lignes) dont le texte « ressemble à un fichier » devient un
 * bouton cliquable plutôt qu'un simple `<code>`. Sans la prop (ex. page
 * Chat), rendu strictement inchangé — le composant `code` n'est même pas
 * surchargé.
 */
import { createContext, memo, useContext, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "./appsAdmin";

function MarkdownLink({ href, children }: Readonly<ComponentProps<"a"> & ExtraProps>) {
  if (!href) return <>{children}</>;
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href).catch(() => {
          // best effort : un lien qui ne s'ouvre pas ne doit jamais casser l'affichage de la transcription
        });
      }}
    >
      {children}
    </a>
  );
}

/** Tableau GFM : conteneur avec défilement horizontal propre (jamais de débordement de la conversation). */
function MarkdownTable({ children }: Readonly<ComponentProps<"table"> & ExtraProps>) {
  return (
    <div className="md__table-wrap">
      <table>{children}</table>
    </div>
  );
}

function flattenText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  return "";
}

/**
 * Heuristique « ressemble à un fichier » : pas d'espace, longueur ≤ 120, et
 * (contient un `/` OU un point suivi d'une extension de 1 à 8 caractères),
 * en excluant ce qui commence par `http://`/`https://` (déjà traité par
 * `MarkdownLink` s'il s'agit d'un vrai lien Markdown — un code inline
 * contenant une URL n'en est pas un).
 */
function looksLikeFileRef(text: string): boolean {
  if (!text || text.length > 120 || /\s/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (text.includes("/")) return true;
  return /\.[^./\s]{1,8}$/.test(text);
}

/**
 * Porte le handler `onFileRef` jusqu'à `MarkdownInlineCode` sans redéfinir
 * de composant à chaque rendu de `Markdown` (le composant `code` passé à
 * `react-markdown` doit garder une identité stable ; le handler, lui, varie
 * librement d'un rendu à l'autre côté appelant).
 */
const FileRefContext = createContext<((ref: string) => void) | null>(null);

function MarkdownInlineCode({ node, className, children }: Readonly<ComponentProps<"code"> & ExtraProps>) {
  const onFileRef = useContext(FileRefContext);
  // Un bloc de code (fence ``` ou indentation) s'étend TOUJOURS sur au moins
  // deux lignes (ligne d'ouverture + contenu, ou plusieurs lignes indentées)
  // — à la différence d'un `code` inline, toujours porté par une seule ligne
  // source. C'est la distinction robuste depuis que react-markdown v9+ n'a
  // plus de prop `inline` sur `code`.
  const isBlock = node?.position ? node.position.start.line !== node.position.end.line : false;
  const text = flattenText(children);

  if (onFileRef && !isBlock && looksLikeFileRef(text)) {
    return (
      <button
        type="button"
        className="md__file-ref"
        title={`Ouvrir « ${text} »`}
        onClick={() => onFileRef(text)}
      >
        {children}
      </button>
    );
  }

  return <code className={className}>{children}</code>;
}

/**
 * Referme une fence de code restée ouverte en fin de contenu (cas du
 * streaming : le ``` fermant n'est pas encore arrivé). Sans ça, tout le texte
 * qui suit l'ouverture bascule en bloc de code puis « ressort » à l'arrivée de
 * la fermeture — le rendu saute. Une fermeture doit utiliser le même caractère
 * (` ou ~) et au moins autant de répétitions que l'ouverture (règle CommonMark).
 */
export function closeDanglingFence(content: string): string {
  let open: { char: string; len: number } | null = null;
  for (const line of content.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    if (!open) open = { char, len };
    else if (char === open.char && len >= open.len) open = null;
  }
  if (!open) return content;
  return content + (content.endsWith("\n") ? "" : "\n") + open.char.repeat(open.len);
}

const baseComponents: Components = { a: MarkdownLink, table: MarkdownTable };
const componentsWithFileRef: Components = { ...baseComponents, code: MarkdownInlineCode };

/**
 * Mémoïsé : le parsing react-markdown est coûteux et les transcriptions
 * longues en cumulent beaucoup — sans memo, CHAQUE frappe dans le composeur
 * (le brouillon vit dans l'état de la page) re-parsait tous les blocs de tous
 * les tours (saisie visiblement ralentie, constaté le 2026-07-31 sur un fil
 * de 500 k tokens). Ne re-rend que si `content` change — à condition que
 * `onFileRef` soit une référence STABLE (voir les wrappers useCallback/ref
 * des pages appelantes).
 */
export const Markdown = memo(function Markdown({
  content,
  onFileRef,
}: Readonly<{ content: string; onFileRef?: (ref: string) => void }>) {
  const components = onFileRef ? componentsWithFileRef : baseComponents;
  return (
    <FileRefContext.Provider value={onFileRef ?? null}>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </FileRefContext.Provider>
  );
});
