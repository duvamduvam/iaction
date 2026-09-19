/*
 * Les deux briques des panneaux latéraux des pages de conversation : le
 * PANNEAU lui-même (`PanneauLateral`, rétractable — voir panneauxLateraux.ts
 * pour l'état partagé et le raccourci Ctrl+L), et la SECTION dépliante qu'il
 * empile (`SidebarSection`). Elles vivent ensemble parce qu'elles ne servent
 * qu'ensemble, et que les pages les importent d'un seul trait.
 *
 * `SidebarSection` : en-tête cliquable (titre + badge optionnel + chevron
 * rotatif) au-dessus d'un contenu repliable. Plusieurs sections peuvent être
 * ouvertes en même temps (pas d'accordéon exclusif — chaque section gère son
 * propre état, indépendamment des autres).
 *
 * Persistance : l'état ouvert/replié de CHAQUE section est mémorisé dans
 * `localStorage` sous la clé `iaction:sidebar:<id>` et relu à l'initiali-
 * sation — `defaultOpen` ne sert qu'au tout premier affichage (aucune entrée
 * `localStorage` encore écrite pour cet `id`), fourni par le parent au cas
 * par cas (ex. section « Fichiers » ouverte par défaut, « MCP » repliée).
 */
import { useState, type ReactNode } from "react";
import { basculerPanneau, usePanneauVisible, type CotePanneau } from "./panneauxLateraux";

const STORAGE_PREFIX = "iaction:sidebar:";

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
  className,
  children,
}: Readonly<{
  /** Identifiant stable de la section — clé `localStorage`, doit être unique dans la page. */
  id: string;
  title: string;
  /** Contenu affiché à droite du titre, avant le chevron (ex. compteur de documents épinglés). */
  badge?: ReactNode;
  /** État initial si aucune préférence n'est encore mémorisée pour cette section. */
  defaultOpen: boolean;
  /**
   * Modificateur posé EN PLUS de `.sidebar-section`. Une seule raison à ce
   * jour : `sidebar-section--extensible`, la section de queue qui prend tout
   * le vide restant de la colonne (section « Outils » d'AgentPage.tsx).
   */
  className?: string;
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
    <section className={`sidebar-section${open ? " sidebar-section--open" : ""}${className ? ` ${className}` : ""}`}>
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

/**
 * Poignée verticale collée au bord du panneau, TOUJOURS montée — repliée, elle
 * est le seul moyen de le faire revenir à la souris (le panneau, lui, est
 * démonté : ni son contenu ni ses requêtes ne tournent pour rien, et le cycle
 * F6 / Alt+flèches l'ignore sans qu'aucun sélecteur de focusZones.ts n'ait à
 * le savoir).
 */
export function PoigneePanneau({ cote }: Readonly<{ cote: CotePanneau }>) {
  const visible = usePanneauVisible(cote);
  const libelle = `${visible ? "Replier" : "Déployer"} le panneau ${cote}`;
  // Chevron tourné vers le mouvement à venir : le panneau part vers son bord
  // en se repliant, il revient vers le centre en se déployant.
  const chevron = (cote === "gauche") === visible ? "‹" : "›";
  return (
    <button
      type="button"
      className={`panneau-poignee panneau-poignee--${cote}${visible ? "" : " panneau-poignee--repliee"}`}
      onClick={() => basculerPanneau(cote)}
      aria-expanded={visible}
      aria-label={libelle}
      title={`${libelle} (Ctrl+L : les deux)`}
    >
      <span className="panneau-poignee__chevron" aria-hidden="true">
        {chevron}
      </span>
    </button>
  );
}

/**
 * Le panneau lui-même : sa poignée (côté bord) et, tant qu'il est déployé,
 * l'`<aside>` qui porte le style commun `.agent-sidebar`. Les pages n'ont donc
 * ni booléen à tenir ni classe à répéter — elles décrivent leur contenu, et le
 * repli est le même des deux côtés et sur les deux pages.
 */
export function PanneauLateral({
  cote,
  children,
}: Readonly<{ cote: CotePanneau; children: ReactNode }>) {
  const visible = usePanneauVisible(cote);
  const poignee = <PoigneePanneau cote={cote} />;
  return (
    <>
      {cote === "gauche" && poignee}
      {visible && (
        <aside className={`agent-sidebar agent-sidebar--${cote === "gauche" ? "left" : "right"}`}>
          {children}
        </aside>
      )}
      {cote === "droit" && poignee}
    </>
  );
}
