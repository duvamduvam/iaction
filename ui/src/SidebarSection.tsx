/*
 * Section dépliante réutilisable pour le panneau latéral gauche de la page
 * Projets (voir AgentPage.tsx) : en-tête cliquable (titre + badge optionnel +
 * chevron rotatif) au-dessus d'un contenu repliable. Plusieurs sections
 * peuvent être ouvertes en même temps (pas d'accordéon exclusif — chaque
 * section gère son propre état, indépendamment des autres).
 *
 * Persistance : l'état ouvert/replié de CHAQUE section est mémorisé dans
 * `localStorage` sous la clé `iaction:sidebar:<id>` et relu à l'initiali-
 * sation — `defaultOpen` ne sert qu'au tout premier affichage (aucune entrée
 * `localStorage` encore écrite pour cet `id`), fourni par le parent au cas
 * par cas (ex. section « Fichiers » ouverte par défaut, « MCP » repliée).
 */
import { useState, type ReactNode } from "react";

const STORAGE_PREFIX = "iaction:sidebar:";

/** Côté d'un panneau latéral — décide de quel bord il se replie. */
export type CotePanneau = "left" | "right";

function readStoredOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // localStorage indisponible (mode privé strict, etc.) : repli sur le défaut fourni.
  }
  return defaultOpen;
}

function writeStoredOpen(id: string, open: boolean) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, open ? "1" : "0");
  } catch {
    // best effort : la préférence ne survivra simplement pas au rechargement
  }
}

export function SidebarSection({
  id,
  title,
  badge,
  defaultOpen,
  children,
}: Readonly<{
  /** Identifiant stable de la section — clé `localStorage`, doit être unique dans la page. */
  id: string;
  title: string;
  /** Contenu affiché à droite du titre, avant le chevron (ex. compteur de documents épinglés). */
  badge?: ReactNode;
  /** État initial si aucune préférence n'est encore mémorisée pour cette section. */
  defaultOpen: boolean;
  children: ReactNode;
}>) {
  const [open, setOpen] = useState(() => readStoredOpen(id, defaultOpen));

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      writeStoredOpen(id, next);
      return next;
    });
  }

  return (
    <section className={`sidebar-section${open ? " sidebar-section--open" : ""}`}>
      <button type="button" className="sidebar-section__head" aria-expanded={open} onClick={toggle}>
        <span className="sidebar-section__title">{title}</span>
        {badge}
        <span className="sidebar-section__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <div className="sidebar-section__body">{children}</div>}
    </section>
  );
}

/*
 * Panneau latéral RÉTRACTABLE : l'`<aside>` lui-même, plus la poignée qui le
 * replie et le déplie.
 *
 * ── Pourquoi un composant, et pas deux lignes dans chaque page ──────────
 * Les deux pages qui portent des panneaux — Projets (gauche ET droite) et
 * Chat (gauche seule) — sont à leur budget de taille au caractère près.
 * Encapsuler l'`<aside>` permet de remplacer une balise ouvrante par une
 * balise ouvrante, sans faire grossir des fichiers que le cliquet cherche
 * précisément à faire maigrir. La poignée, l'état et la persistance vivent
 * ici, à un seul endroit.
 *
 * ── Indépendance ────────────────────────────────────────────────────────
 * Chaque panneau porte son propre `id`, donc sa propre clé de persistance et
 * son propre état : replier celui de gauche ne touche pas celui de droite.
 * Même mécanique que `SidebarSection` ci-dessus, et même tolérance — un
 * `localStorage` indisponible coûte la mémoire de la préférence, rien d'autre.
 *
 * ── La poignée reste TOUJOURS affichée ──────────────────────────────────
 * Replié, le panneau n'est plus rendu du tout (et non caché en largeur nulle :
 * ses listes et ses champs ne consomment plus rien). C'est la poignée, elle,
 * qui ne disparaît jamais — sans quoi il n'existerait plus aucun moyen de
 * ramener le panneau, et « replier » deviendrait « perdre ».
 */
export function SidebarRetractable({
  id,
  cote,
  libelle,
  children,
}: Readonly<{
  /** Identifiant stable — clé `localStorage`, unique dans l'application. */
  id: string;
  cote: CotePanneau;
  /** Nom du panneau dans l'infobulle et l'étiquette d'accessibilité (« Sessions », « Projet »…). */
  libelle: string;
  children: ReactNode;
}>) {
  // Déplié au premier affichage : la disposition connue de tous reste celle
  // d'avant, et le repli est un geste que l'on choisit.
  const [ouvert, setOuvert] = useState(() => readStoredOpen(id, true));

  function basculer() {
    setOuvert((prev) => {
      const suivant = !prev;
      writeStoredOpen(id, suivant);
      return suivant;
    });
  }

  // Le chevron montre le MOUVEMENT que produira le clic, pas l'état courant :
  // déplié, il pointe vers le bord où le panneau va se ranger ; replié, vers
  // l'endroit d'où il reviendra.
  const versLaGauche = cote === "left" ? ouvert : !ouvert;
  const panneau = ouvert ? (
    <aside className={`agent-sidebar agent-sidebar--${cote}`}>{children}</aside>
  ) : null;
  const poignee = (
    <button
      type="button"
      className={`sidebar-rail sidebar-rail--${cote}`}
      aria-expanded={ouvert}
      aria-label={`${ouvert ? "Replier" : "Déplier"} le panneau ${libelle}`}
      title={`${ouvert ? "Replier" : "Déplier"} le panneau ${libelle}`}
      onClick={basculer}
    >
      <span className="sidebar-rail__chevron" aria-hidden="true">
        {versLaGauche ? "‹" : "›"}
      </span>
    </button>
  );

  // L'ordre du DOM suit l'ordre VISUEL, des deux côtés : c'est lui que suit
  // aussi la tabulation, et une poignée qu'on atteint au clavier avant ou
  // après le panneau selon le côté serait une désorientation gratuite.
  return cote === "left" ? (
    <>
      {panneau}
      {poignee}
    </>
  ) : (
    <>
      {poignee}
      {panneau}
    </>
  );
}
