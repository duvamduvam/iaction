/*
 * Barre d'onglets — conversations ouvertes, bouton « + », fichiers ouverts.
 * Partagée par la page Projets (AgentPage.tsx) et la page Chat (ChatPage.tsx).
 *
 * ── Pourquoi ce composant existe (T-109) ────────────────────────────────
 * Cette barre était écrite DEUX FOIS, à 99 % identique, au milieu de deux
 * fichiers de ~2 800 lignes. Ajouter la fermeture en lot (menu contextuel)
 * aurait dupliqué une troisième mécanique dans les deux — exactement ce que
 * le cliquet de taille interdit, et pour la bonne raison : ce qui n'est pas
 * extrait n'est jamais testé. La barre sort donc ici, la décision de lot est
 * pure et testée à côté (fermetureOnglets.ts), et les deux pages ne gardent
 * que ce qu'elles seules savent faire : fermer VRAIMENT un onglet, avec tout
 * l'état de session que ça remue.
 *
 * ── Ce que ce composant ne fait PAS ─────────────────────────────────────
 * Il ne ferme rien lui-même. Il appelle `onFermerConversation`/`onFermerFichier`
 * pour l'unitaire (garde du tour en cours, confirmation d'un fichier modifié :
 * la page les tenait déjà) et `onFermerLot*` pour les lots, avec une liste
 * déjà purgée des onglets protégés. Il ne connaît pas non plus le bandeau
 * d'avis : il rend le message par `onAvis`, dans l'encart que la page affiche
 * déjà sous la barre.
 *
 * ── Clic milieu ─────────────────────────────────────────────────────────
 * Standard partout (navigateurs, VS Code, IntelliJ) : le clic milieu ferme
 * l'onglet survolé. Il passe par le MÊME chemin unitaire que le « × », donc
 * mêmes garde-fous — un clic milieu malheureux sur un fichier modifié demande
 * confirmation, il n'avale rien.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  itemsMenuOnglets,
  messageLot,
  resoudreLot,
  type ActionLot,
  type OngletDeBarre,
} from "./fermetureOnglets";
import { ongletPourChiffre, raccourciDeLaPosition } from "./raccourciOnglets";
import { titresDistinctifs } from "./titresOnglets";
import { useRovingFocus } from "./useRovingFocus";

export interface OngletConversationVue {
  id: string;
  titre: string;
  /** Un tour streame dans cet onglet — visible (point cyan) et infermable. */
  streaming: boolean;
}

export interface OngletFichierVue {
  chemin: string;
  nom: string;
  /** Modifications non enregistrées : point discret, et jamais fermé en lot. */
  modifie: boolean;
}

export interface BarreOngletsProps {
  conversations: readonly OngletConversationVue[];
  /** Absent sur la page Chat, qui n'ouvre pas de fichiers. */
  fichiers?: readonly OngletFichierVue[];
  /** Conversation dont l'onglet est actif, `null` si c'est un fichier qui l'est. */
  conversationActive: string | null;
  fichierActif?: string | null;
  onActiverConversation: (id: string) => void;
  onActiverFichier?: (chemin: string) => void;
  onNouvelleConversation: () => void;
  /** Fermeture unitaire (« × », clic milieu, item « Fermer ») — garde-fous côté page. */
  onFermerConversation: (id: string) => void;
  onFermerFichier?: (chemin: string) => void;
  /** Fermeture en lot : la liste est déjà purgée des onglets protégés. */
  onFermerLotConversations: (ids: string[]) => void;
  onFermerLotFichiers?: (chemins: string[]) => void;
  /** Bandeau sous la barre : rend compte des onglets conservés (jamais d'échec muet). */
  onAvis: (message: string | null) => void;
}

interface EtatMenu {
  ancre: string;
  x: number;
  y: number;
}

export function BarreOnglets({
  conversations,
  fichiers = [],
  conversationActive,
  fichierActif = null,
  onActiverConversation,
  onActiverFichier,
  onNouvelleConversation,
  onFermerConversation,
  onFermerFichier,
  onFermerLotConversations,
  onFermerLotFichiers,
  onAvis,
}: Readonly<BarreOngletsProps>) {
  const roving = useRovingFocus<HTMLDivElement>({ selector: '[role="tab"]', orientation: "horizontal" });
  const [menu, setMenu] = useState<EtatMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Fermeture au clic extérieur ou à Échap — même mécanique que les deux
  // autres menus contextuels du projet (FileTree.tsx, menuReference.tsx).
  useEffect(() => {
    if (!menu) return;
    function fermer() {
      setMenu(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", fermer);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", fermer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  // Recale le menu s'il déborde de la fenêtre : la barre d'onglets touche le
  // haut de l'écran, un menu ouvert sur le dernier onglet sortirait à droite.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setPosition(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4)),
    });
  }, [menu]);

  /** La barre telle que la voit la décision de lot — ordre d'affichage compris. */
  const onglets: OngletDeBarre[] = [
    ...conversations.map((c) => ({
      id: c.id,
      famille: "conversation" as const,
      protection: c.streaming ? ("tour-en-cours" as const) : null,
    })),
    ...fichiers.map((f) => ({
      id: f.chemin,
      famille: "fichier" as const,
      protection: f.modifie ? ("non-enregistre" as const) : null,
    })),
  ];

  /* Libellé de chaque onglet de conversation — le titre STOCKÉ reste entier
     (infobulle, liste des sessions) ; seul l'affichage est replié quand deux
     onglets ouverts commencent par les mêmes mots (T-122, titresOnglets.ts). */
  const libelles = titresDistinctifs(conversations.map((c) => c.titre));

  // Accès « toujours frais » depuis l'écouteur monté une seule fois ci-dessous
  // (même patron que `optionsRef`, useVoiceComposer.ts) : `onglets` est un
  // nouveau tableau à chaque rendu, le réabonner à chaque fois agiterait le
  // listener pour rien pendant un streaming qui redessine la page en continu.
  const ongletsRef = useRef(onglets);
  ongletsRef.current = onglets;
  const onActiverConversationRef = useRef(onActiverConversation);
  onActiverConversationRef.current = onActiverConversation;
  const onActiverFichierRef = useRef(onActiverFichier);
  onActiverFichierRef.current = onActiverFichier;

  /*
   * Alt+1…Alt+9 (T-122, levier C) : accès direct à l'onglet de cette
   * position, convention navigateur (voir raccourciOnglets.ts). `e.code`
   * plutôt que `e.key`, même raison que Ctrl+1..6 dans App.tsx : stable au
   * pavé numérique, verrouillage numérique éteint compris.
   *
   * Garde de visibilité : les deux pages (Projets, Chat) restent montées en
   * permanence, seulement masquées par `.page-slot--hidden` (`display:none`,
   * voir App.css/App.tsx) — sans ce test, la barre de la page qu'on NE
   * regarde PAS répondrait aussi à la frappe. `offsetParent === null` détecte
   * cet ancêtre masqué sans qu'il faille faire remonter un `pageVisible`
   * jusqu'ici (cette barre n'a pas cette prop, et l'ajouter demanderait de
   * toucher AgentPage.tsx/ChatPage.tsx — hors périmètre de ce chantier).
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (roving.containerRef.current?.offsetParent == null) return;
      const match = /^(?:Numpad|Digit)([1-9])$/.exec(e.code);
      if (!match) return;
      const cible = ongletPourChiffre(Number(match[1]), ongletsRef.current.length);
      if (cible == null) return;
      e.preventDefault();
      const onglet = ongletsRef.current[cible];
      if (onglet.famille === "conversation") onActiverConversationRef.current(onglet.id);
      else onActiverFichierRef.current?.(onglet.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [roving.containerRef]);

  function ouvrirMenu(e: ReactMouseEvent, ancre: string) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ ancre, x: e.clientX, y: e.clientY });
  }

  function fermerUnitaire(id: string, famille: "conversation" | "fichier") {
    if (famille === "conversation") onFermerConversation(id);
    else onFermerFichier?.(id);
  }

  function lancerLot(action: ActionLot, ancre: string) {
    const resultat = resoudreLot(onglets, ancre, action);
    onAvis(messageLot(resultat));
    if (resultat.aFermer.length === 0) return;
    const partants = new Set(resultat.aFermer);
    const conversationsAFermer = conversations.filter((c) => partants.has(c.id)).map((c) => c.id);
    const fichiersAFermer = fichiers.filter((f) => partants.has(f.chemin)).map((f) => f.chemin);
    // Un lot ne mélange jamais les deux familles (voir fermetureOnglets.ts) :
    // l'un des deux appels est toujours à vide.
    if (conversationsAFermer.length > 0) onFermerLotConversations(conversationsAFermer);
    if (fichiersAFermer.length > 0) onFermerLotFichiers?.(fichiersAFermer);
  }

  const ancre = menu ? onglets.find((o) => o.id === menu.ancre) : undefined;

  return (
    <>
      <div
        className="agent-tabs"
        role="tablist"
        ref={roving.containerRef}
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        {conversations.map((conv, i) => {
          const isActive = conversationActive === conv.id;
          const libelle = libelles[i];
          // Numéro de POSITION dans la barre (pas l'identité de la
          // conversation, T-122 levier C) et raccourci direct qui y mène,
          // s'il en existe un (Alt+1…Alt+8, ou Alt+9 pour le tout dernier).
          const numero = i + 1;
          const raccourci = raccourciDeLaPosition(i, onglets.length);
          const titreEtRaccourci = raccourci ? `${conv.titre} (${raccourci})` : conv.titre;
          return (
            <div
              key={conv.id}
              className={`agent-tab agent-tab--conv${isActive ? " agent-tab--active" : ""}`}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={titreEtRaccourci}
              // Un libellé replié commence par « … » : le nom accessible de
              // l'onglet doit rester le titre entier, sans quoi un lecteur
              // d'écran annoncerait justement la partie qu'on a coupée. Le
              // raccourci, lui, s'annonce dès qu'il existe, replié ou pas.
              aria-label={libelle === conv.titre && !raccourci ? undefined : titreEtRaccourci}
              onClick={() => onActiverConversation(conv.id)}
              onContextMenu={(e) => ouvrirMenu(e, conv.id)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onFermerConversation(conv.id);
              }}
              onKeyDown={(e) => {
                // `target === currentTarget` : ne pas intercepter Entrée sur
                // le bouton « × » interne (fermeture native du bouton).
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onActiverConversation(conv.id);
                }
              }}
            >
              {/* Discret : repère visuel de position, le raccourci qui y mène
                  est déjà annoncé par `title`/`aria-label` ci-dessus. */}
              <span className="agent-tab__num" aria-hidden="true">
                {numero}
              </span>
              <span className="agent-tab__name">{libelle}</span>
              {conv.streaming && (
                <span
                  className="agent-tab__dot agent-tab__dot--streaming"
                  aria-label="Tour en cours"
                  title="Tour en cours"
                />
              )}
              <button
                type="button"
                className="agent-tab__close"
                aria-label={`Fermer l'onglet ${conv.titre}`}
                title={conv.streaming ? "Impossible de fermer : tour en cours" : "Fermer l'onglet"}
                disabled={conv.streaming}
                onClick={(e) => {
                  e.stopPropagation();
                  onFermerConversation(conv.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="agent-tab agent-tab--new"
          onClick={() => onNouvelleConversation()}
          aria-label="Nouvelle conversation"
          title="Nouvelle conversation (Ctrl+N)"
        >
          +
        </button>
        {fichiers.map((f, j) => {
          const isActive = fichierActif === f.chemin;
          // Position dans la barre COMPLÈTE (conversations puis fichiers,
          // même ordre que `onglets` ci-dessus) : les onglets de fichier
          // reprennent la numérotation où les conversations l'ont laissée.
          // (Nommée `indexBarre` et non `position` : ce nom est déjà pris par
          // l'état de placement du menu contextuel, ci-dessus dans ce fichier.)
          const indexBarre = conversations.length + j;
          const numero = indexBarre + 1;
          const raccourci = raccourciDeLaPosition(indexBarre, onglets.length);
          const titreEtRaccourci = raccourci ? `${f.chemin} (${raccourci})` : f.chemin;
          return (
            <div
              key={f.chemin}
              className={`agent-tab${isActive ? " agent-tab--active" : ""}`}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={titreEtRaccourci}
              aria-label={raccourci ? `${f.nom} (${raccourci})` : undefined}
              onClick={() => onActiverFichier?.(f.chemin)}
              onContextMenu={(e) => ouvrirMenu(e, f.chemin)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onFermerFichier?.(f.chemin);
              }}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onActiverFichier?.(f.chemin);
                }
              }}
            >
              <span className="agent-tab__num" aria-hidden="true">
                {numero}
              </span>
              <span className="agent-tab__name">{f.nom}</span>
              {f.modifie && <span className="agent-tab__dot" aria-hidden="true" title="Modifié" />}
              <button
                type="button"
                className="agent-tab__close"
                aria-label={`Fermer ${f.nom}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFermerFichier?.(f.chemin);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {menu && ancre && (
        <div
          ref={menuRef}
          className="file-tree__context-menu"
          style={{ left: `${position?.left ?? menu.x}px`, top: `${position?.top ?? menu.y}px` }}
          // Le `mousedown` global ferme le menu (effet ci-dessus) : on stoppe sa
          // propagation pour qu'un clic SUR le menu laisse `onClick` s'exécuter.
          onMouseDown={(e: ReactMouseEvent) => e.stopPropagation()}
          role="menu"
          tabIndex={-1}
        >
          {itemsMenuOnglets(onglets, menu.ancre).map((item) => (
            // Fragment et non <div> : les items sont des enfants DIRECTS du
            // menu (flex column), sinon chaque bouton se rétracte à la largeur
            // de son texte et le survol ne couvre plus la ligne.
            <Fragment key={item.cle}>
              {item.separateurAvant && <div className="file-tree__context-menu-separator" role="separator" />}
              <button
                type="button"
                className="file-tree__context-menu-item"
                role="menuitem"
                disabled={!item.actif}
                onClick={() => {
                  setMenu(null);
                  if (item.cle === "cet-onglet") fermerUnitaire(ancre.id, ancre.famille);
                  else lancerLot(item.cle, menu.ancre);
                }}
              >
                {item.libelle}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}
