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
