/*
 * Rendu Markdown (GFM) en éléments React pour les transcriptions (blocs de
 * texte de l'ASSISTANT uniquement — voir AgentPage.tsx/ChatPage.tsx, les
 * messages utilisateur restent en texte brut pre-wrap). `react-markdown` +
 * `remark-gfm`, sans `rehype-raw` : le HTML brut éventuellement présent dans
 * le texte n'est donc PAS interprété (échappé tel quel), aucun
 * `dangerouslySetInnerHTML` nulle part.
 *
 * Liens : `target="_blank"` est inopérant en webview Tauri (pas d'onglet à
 * ouvrir) — on intercepte le clic et on route vers `open_external`, en passant
 * par le REGISTRE d'applications (T-049) : un `.html` cité part dans le
 * navigateur déclaré par l'utilisateur, et non dans celui que le système a
 * décidé d'être le sien. Sans règle applicable, repli sur `xdg-open`, qui
 * accepte aussi bien un chemin qu'une URL.
 *
 * Références de fichiers cliquables (page Agent, voir AgentPage.tsx) : si
 * `onFileRef` est fourni, un `code` INLINE (pas un bloc — distingué via
 * `node.position` : une portée mono-ligne, un bloc de code fence toujours
 * au moins deux lignes) dont le texte peut réellement s'ouvrir devient un
 * bouton cliquable plutôt qu'un simple `<code>`. Ce « peut réellement
 * s'ouvrir » vit dans refFichier.ts, et c'est le même jugement qui décide de
 * l'ouverture : un bouton ne promet donc plus ce que le clic ne sait pas tenir
 * (T-024). Sans la prop (ex. page Chat), rendu strictement inchangé — le
 * composant `code` n'est même pas surchargé.
 *
 * Ouverture au survol (T-104, option désactivée par défaut — voir
 * survolReference.ts) : quand elle est active, le bouton de référence s'ARME
 * au survol souris et s'ouvre tout seul au bout du délai réglé. Trois
 * garde-fous, tous dans `MarkdownInlineCode` : seul un pointeur SOURIS arme
 * le minuteur (le tactile n'a pas de survol, une pression longue ne doit rien
 * ouvrir) ; sortir de la puce, cliquer dessus ou démonter le composant
 * l'annule ; un déclenchement ne se réarme qu'après être ressorti puis
 * rentré. L'ouverture elle-même reste `fileRef.ouvrir`, inchangée à l'octet
 * près — seul le déclencheur change.
 *
 * Clic droit (T-108) : ouvre le même menu contextuel que l'arbre de fichiers
 * (voir menuReference.tsx) — le clic gauche garde sa politique par défaut,
 * le menu propose les autres voies (registre, système, éditeur, copier).
 */
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDossierPersonnel } from "./dossierPersonnel";
import { ouvrirMenuReference } from "./menuReference";
import { estReferenceCliquable, ouvrirLienExterne, type ForcageOuverture } from "./refFichier";
import { doitArmerSurvol, useDelaiSurvol } from "./survolReference";

function MarkdownLink({ href, children }: Readonly<ComponentProps<"a"> & ExtraProps>) {
  if (!href) return <>{children}</>;
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        ouvrirLienExterne(href).catch(() => {
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
 * Porte le handler `onFileRef` jusqu'à `MarkdownInlineCode` sans redéfinir
 * de composant à chaque rendu de `Markdown` (le composant `code` passé à
 * `react-markdown` doit garder une identité stable ; le handler, lui, varie
 * librement d'un rendu à l'autre côté appelant).
 */
const FileRefContext = createContext<{
  ouvrir: (ref: string, forcer?: ForcageOuverture) => void;
  cwd: string | null;
  delaiSurvol: number | null;
  home: string | null;
} | null>(null);

function MarkdownInlineCode({ node, className, children }: Readonly<ComponentProps<"code"> & ExtraProps>) {
  const fileRef = useContext(FileRefContext);
  // Un bloc de code (fence ``` ou indentation) s'étend TOUJOURS sur au moins
  // deux lignes (ligne d'ouverture + contenu, ou plusieurs lignes indentées)
  // — à la différence d'un `code` inline, toujours porté par une seule ligne
  // source. C'est la distinction robuste depuis que react-markdown v9+ n'a
  // plus de prop `inline` sur `code`.
  const isBlock = node?.position ? node.position.start.line !== node.position.end.line : false;
  const text = flattenText(children);

  // Hooks en tête de composant : le `return` conditionnel du chemin
  // `<code>` inerte, plus bas, ne doit jamais les priver de s'exécuter.
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Un déclenchement ne se réarme qu'après être ressorti PUIS rentré — sans
  // ça, un `onPointerEnter` qui se redéclenche pendant que le minuteur tourne
  // (ré-hover d'un même geste) rouvrirait le fichier en boucle.
  const declenche = useRef(false);
  // État affiché (remplissage CSS) — distinct du ref ci-dessus : muter un ref
  // dans un handler ne redéclenche pas de rendu, il faut du state pour que la
  // classe `--arme` apparaisse à l'écran.
  const [arme, setArme] = useState(false);

  function annulerMinuteur() {
    if (minuteur.current !== null) {
      clearTimeout(minuteur.current);
      minuteur.current = null;
    }
    setArme(false);
  }

  // Un minuteur qui survit au démontage ouvrirait un fichier après coup —
  // par exemple si la transcription change de tour pendant que le survol court.
  useEffect(() => annulerMinuteur, []);

  if (fileRef && !isBlock && estReferenceCliquable(text, fileRef.cwd, fileRef.home)) {
    const delai = fileRef.delaiSurvol;
    // Chemin sans survol (option désactivée, page Chat) : mêmes attributs,
    // même infobulle qu'avant T-104, à l'octet près — pas de handler de
    // pointeur inutile posé sur le bouton.
    const handlersSurvol =
      delai === null
        ? {}
        : {
            onPointerEnter: (e: PointerEvent<HTMLButtonElement>) => {
              // La décision (et ses trois garde-fous) vit dans survolReference.ts,
              // seul endroit où elle est testable sans DOM.
              if (!doitArmerSurvol(delai, e.pointerType, declenche.current)) return;
              setArme(true);
              minuteur.current = setTimeout(() => {
                minuteur.current = null;
                declenche.current = true;
                setArme(false);
                fileRef.ouvrir(text);
              }, delai);
            },
            onPointerLeave: () => {
              annulerMinuteur();
              declenche.current = false;
            },
            onPointerDown: annulerMinuteur,
          };
    return (
      <button
        type="button"
        className={arme ? "md__file-ref md__file-ref--arme" : "md__file-ref"}
        style={arme ? ({ "--md-survol-delai": `${delai}ms` } as CSSProperties) : undefined}
        title={delai !== null ? `Ouvrir « ${text} » — s'ouvre au survol` : `Ouvrir « ${text} »`}
        onClick={() => fileRef.ouvrir(text)}
        // Clic droit (T-108) : le même menu que l'arbre de fichiers — voir
        // menuReference.tsx, monté une seule fois par le composant de liste.
        onContextMenu={(e) => {
          e.preventDefault();
          ouvrirMenuReference(text, e.clientX, e.clientY);
        }}
        {...handlersSurvol}
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
  cwd = null,
}: Readonly<{
  content: string;
  onFileRef?: (ref: string, forcer?: ForcageOuverture) => void;
  cwd?: string | null;
}>) {
  const components = onFileRef ? componentsWithFileRef : baseComponents;
  const delaiSurvol = useDelaiSurvol();
  const home = useDossierPersonnel();
  // Identité stable : un contexte dont la valeur change à chaque rendu re-rend
  // tous ses consommateurs, ce qui annulerait le `memo` ci-dessus — et c'est
  // lui qui rend la frappe au clavier tenable sur une longue transcription.
  const valeur = useMemo(
    () => (onFileRef ? { ouvrir: onFileRef, cwd, delaiSurvol, home } : null),
    [onFileRef, cwd, delaiSurvol, home],
  );
  return (
    <FileRefContext.Provider value={valeur}>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </FileRefContext.Provider>
  );
});
