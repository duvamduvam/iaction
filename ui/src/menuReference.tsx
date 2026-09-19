/*
 * Menu contextuel (clic droit) sur une référence de fichier citée dans le fil
 * (T-108) — le pendant du menu déjà offert par l'arbre de fichiers depuis le
 * Lot 5 (voir FileTree.tsx, lignes ~600-760), pour la MÊME décision : quelle
 * voie d'ouverture choisir pour ce fichier ?
 *
 * ── Pourquoi un magasin module-scope ─────────────────────────────────────
 * Même patron que `survolReference.ts`/`dossierPersonnel.ts` : un état
 * `{ ref, x, y } | null` partagé, consulté via `useSyncExternalStore`. Le
 * bouton de référence (`Markdown.tsx`) ouvre le menu par son `onContextMenu`
 * sans avoir à connaître le composant qui le rend — c'est `<MenuReference>`,
 * monté UNE fois par le composant de liste (voir `agentTranscript.tsx`), qui
 * écoute ce magasin et s'affiche quand il devient non nul.
 *
 * ── Pourquoi la décision (`itemsDuMenu`) est une fonction PURE ───────────
 * Le projet n'a pas d'environnement DOM en test (voir le cliquet de taille
 * et sa doctrine) : ce qui n'expose rien ne se teste plus. La question posée
 * par ce menu — quels items proposer pour CETTE résolution, avec CE
 * registre ? — doit donc être prouvable sans monter quoi que ce soit, d'où
 * son extraction ici plutôt qu'au fond d'un rendu conditionnel.
 *
 * ── Même politique d'ouverture que le clic gauche ────────────────────────
 * Un item « Ouvrir … » n'invente aucune action : il appelle `onOuvrir`, le
 * MÊME callback que le clic gauche (`ouvrirReference`, via `ContexteOuverture
 * .forcer`, voir refFichier.ts) — il n'existe jamais deux politiques
 * d'ouverture pour une même référence, seulement la voie que ce clic force.
 *
 * ── Classes CSS empruntées à FileTree.tsx ────────────────────────────────
 * `file-tree__context-menu`/`file-tree__context-menu-item` : aucun style
 * neuf, ce menu reste dans la MÊME famille visuelle que celui de l'arbre —
 * même mécanique de fermeture (clic extérieur, Échap), même apparence.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { openExternal, useApps, type AppEntry } from "./appsAdmin";
import { sondesDisque } from "./fsClient";
import { useDossierPersonnel } from "./dossierPersonnel";
import {
  appPour,
  repertoireParent,
  resoudreReference,
  type ForcageOuverture,
  type ResolutionReference,
} from "./refFichier";
import type { AgentTurn } from "./agentTurns";

interface EtatMenuReference {
  ref: string;
  x: number;
  y: number;
}

let cache: EtatMenuReference | null = null;
const listeners = new Set<() => void>();

function notifier(): void {
  for (const cb of listeners) cb();
}

/** Ouvre le menu pour cette référence, au point de clic (coordonnées écran). */
export function ouvrirMenuReference(ref: string, x: number, y: number): void {
  cache = { ref, x, y };
  notifier();
}

export function fermerMenuReference(): void {
  if (cache === null) return;
  cache = null;
  notifier();
}

function etatCourant(): EtatMenuReference | null {
  return cache;
}

export function subscribeMenuReference(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Instantané réactif du magasin — `null` quand aucun menu n'est ouvert. */
export function useMenuReference(): EtatMenuReference | null {
  return useSyncExternalStore(subscribeMenuReference, etatCourant, etatCourant);
}

export interface ItemMenu {
  cle: ForcageOuverture | "copier" | "dossier";
  libelle: string;
}

/**
 * Les items proposés pour une résolution donnée. Pure — c'est ce qui la
 * rend testable sans monter le composant (voir l'en-tête du module).
 *
 *  - « fichier » : « Ouvrir avec <règle> » seulement si une règle s'applique,
 *    « Ouvrir avec l'application système » toujours, « Ouvrir dans
 *    l'éditeur » seulement si le fichier est sous le projet (T-024), puis
 *    « Copier le chemin » et « Ouvrir le dossier » ;
 *  - « dossier » : « Ouvrir le dossier » (le dossier LUI-MÊME) et « Copier le
 *    chemin » — ni règle d'application ni éditeur interne pour un répertoire ;
 *  - « distant » : « Ouvrir le lien » (même voie que `ouvrirLienExterne` —
 *    registre puis navigateur système, d'où le `cle: "app"` réemployé) et
 *    « Copier le lien » ;
 *  - « impossible » : aucun item, le menu se contente d'afficher le message.
 */
export function itemsDuMenu(resolution: ResolutionReference, apps: AppEntry[]): ItemMenu[] {
  if (resolution.etat === "impossible") return [];
  if (resolution.etat === "distant") {
    return [
      { cle: "app", libelle: "Ouvrir le lien" },
      { cle: "copier", libelle: "Copier le lien" },
    ];
  }
  /*
   * Un dossier (T-119) : deux items, et pas un de plus. « Ouvrir avec … » n'a
   * pas de sens (le registre est indexé par extension), « Ouvrir dans
   * l'éditeur » non plus (il ouvre des fichiers). Ici l'item « dossier »
   * désigne le dossier LUI-MÊME, pas son parent comme pour un fichier — c'est
   * `handleItem` qui fait cette distinction, sur l'état de la résolution.
   */
  if (resolution.etat === "dossier") {
    return [
      { cle: "dossier", libelle: "Ouvrir le dossier" },
      { cle: "copier", libelle: "Copier le chemin" },
    ];
  }
  const items: ItemMenu[] = [];
  const app = appPour(apps, resolution.nom);
  if (app) items.push({ cle: "app", libelle: `Ouvrir avec ${app.label}` });
  items.push({ cle: "systeme", libelle: "Ouvrir avec l'application système" });
  if (resolution.sousProjet) items.push({ cle: "editeur", libelle: "Ouvrir dans l'éditeur" });
  items.push({ cle: "copier", libelle: "Copier le chemin" });
  items.push({ cle: "dossier", libelle: "Ouvrir le dossier" });
  return items;
}

/** Texte à copier pour l'item « copier » — le chemin d'un fichier, l'URL d'un distant. */
function texteACopier(resolution: ResolutionReference): string {
  if (resolution.etat === "fichier" || resolution.etat === "dossier") return resolution.chemin;
  if (resolution.etat === "distant") return resolution.url;
  return "";
}

/**
 * Composant hôte du menu — rendu UNE fois par le composant de liste (voir
 * agentTranscript.tsx), jamais par tour. Résout la référence à l'ouverture
 * (affiche « Résolution… » pendant l'attente), puis les items ou le message
 * d'échec ; se ferme au clic extérieur ou à Échap, exactement comme le menu
 * de FileTree.tsx.
 */
export function MenuReference({
  cwd,
  turns,
  onOuvrir,
}: Readonly<{
  cwd: string | null;
  turns: readonly AgentTurn[];
  onOuvrir: (ref: string, forcer?: ForcageOuverture) => void;
}>) {
  const etat = useMenuReference();
  const apps = useApps();
  const home = useDossierPersonnel();
  const [resolution, setResolution] = useState<ResolutionReference | null>(null);
  // Échec d'une action propre au menu (copie, ouverture du dossier) : ces
  // deux-là n'ont pas d'autre canal d'affichage que le menu lui-même — à la
  // différence des items « Ouvrir … », qui passent par `onOuvrir` et donc
  // par l'encart d'avis déjà câblé côté page (jamais d'échec muet, T-024).
  const [erreurAction, setErreurAction] = useState<string | null>(null);

  useEffect(() => {
    setResolution(null);
    setErreurAction(null);
    if (!etat || !cwd) return;
    let annule = false;
    resoudreReference(etat.ref, {
      cwd,
      turns,
      apps,
      home,
      ...sondesDisque,
      // Jamais appelés par `resoudreReference` (résolution seule, T-108) —
      // présents pour satisfaire le contrat partagé avec `ouvrirReference`.
      ouvrirDansEditeur: () => {},
      ouvrirDansApp: async () => {},
      avis: () => {},
    }).then((r) => {
      if (!annule) setResolution(r);
    });
    return () => {
      annule = true;
    };
    // `apps`/`home` varient par identité à chaque rendu (hooks externes) :
    // seule la RÉFÉRENCE citée doit relancer la résolution, pas eux — sans
    // quoi une frappe ailleurs dans la page rouvrirait la résolution en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etat, cwd]);

  // Fermeture au clic extérieur ou à Échap — mécanique reprise de
  // FileTree.tsx (voir son `useEffect` sur `contextMenu`).
  useEffect(() => {
    if (!etat) return;
    function onPointerDown() {
      fermerMenuReference();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") fermerMenuReference();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [etat]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Recale le menu s'il déborde à droite ou en bas de la fenêtre — la
  // transcription occupe le centre de l'écran, un menu ouvert près du bord
  // serait sinon coupé.
  useLayoutEffect(() => {
    if (!etat || !menuRef.current) {
      setPosition(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(etat.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(etat.y, window.innerHeight - rect.height - 4));
    setPosition({ left, top });
  }, [etat, resolution]);

  if (!etat) return null;
  // Alias local : TS ne conserve pas le rétrécissement de `etat` dans les
  // fonctions imbriquées ci-dessous (fermetures) — `ref` évite de le
  // redemander sans passer par un `!`.
  const ref = etat.ref;

  const items = resolution ? itemsDuMenu(resolution, apps) : [];

  async function copier(texte: string) {
    try {
      await navigator.clipboard.writeText(texte);
      fermerMenuReference();
    } catch {
      // Presse-papier refusé (contexte non sécurisé, permission) — on le dit,
      // jamais d'échec muet (même geste que SystemPage.tsx `handleCopier`).
      setErreurAction("Copie impossible : presse-papier inaccessible.");
    }
  }

  /** `chemin` est ouvert TEL QUEL : l'appelant a déjà choisi le dossier visé. */
  async function ouvrirDossier(chemin: string) {
    try {
      await openExternal(chemin, null);
      fermerMenuReference();
    } catch (err) {
      setErreurAction(err instanceof Error ? err.message : String(err));
    }
  }

  function handleItem(item: ItemMenu) {
    if (!resolution) return;
    if (item.cle === "copier") {
      void copier(texteACopier(resolution));
      return;
    }
    if (item.cle === "dossier") {
      // Pour un fichier, « le dossier » est son PARENT ; pour un dossier
      // résolu (T-119), c'est lui-même — l'ouvrir par son parent afficherait
      // le voisinage au lieu du contenu demandé.
      if (resolution.etat === "fichier") void ouvrirDossier(repertoireParent(resolution.chemin));
      if (resolution.etat === "dossier") void ouvrirDossier(resolution.chemin);
      return;
    }
    fermerMenuReference();
    onOuvrir(ref, item.cle);
  }

  const left = position?.left ?? etat.x;
  const top = position?.top ?? etat.y;

  return (
    <div
      ref={menuRef}
      className="file-tree__context-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      // Le `mousedown` global ferme le menu (effet ci-dessus) : on stoppe sa
      // propagation ici pour qu'un clic SUR le menu ne se ferme pas avant que
      // `onClick` ait pu s'exécuter sur l'item choisi (même garde que FileTree.tsx).
      onMouseDown={(e: ReactMouseEvent) => e.stopPropagation()}
      role="menu"
      tabIndex={-1}
    >
      {!resolution && <div className="file-tree__context-menu-item">Résolution…</div>}
      {resolution?.etat === "impossible" && <div className="file-tree__context-menu-item">{resolution.message}</div>}
      {resolution &&
        resolution.etat !== "impossible" &&
        items.map((item) => (
          <button
            key={item.cle}
            type="button"
            className="file-tree__context-menu-item"
            role="menuitem"
            onClick={() => handleItem(item)}
          >
            {item.libelle}
          </button>
        ))}
      {erreurAction && <div className="file-tree__context-menu-item">{erreurAction}</div>}
    </div>
  );
}
