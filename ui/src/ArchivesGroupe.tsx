/*
 * Groupe « Archives » de la liste des sessions — partagé par la page Projets
 * (agentSidebarDroit.tsx, T-151) et la page Chat (ChatPage.tsx, T-152).
 */
import { useState } from "react";

import type { EntreeArchive } from "./archivesSessions";
import { formatRelativeDate } from "./sessionStore";

/**
 * Groupe repliable « Archives (n) », replié par défaut, absent si n = 0.
 * Mêmes classes que la liste des sessions ; le clic restaure, la corbeille met
 * de côté (aucune confirmation : rien n'est détruit).
 */
export function ArchivesGroupe({
  archives,
  restoreArchive,
  trashArchive,
  rechercheActive,
  unite = "tours",
}: Readonly<{
  archives: EntreeArchive[];
  restoreArchive: (id: string) => void;
  trashArchive: (id: string) => void;
  /** Une recherche est en cours : le groupe s'ouvre seul puisqu'il contient un résultat. */
  rechercheActive: boolean;
  /** Ce que compte `nbTours` : des « tours » côté Projets, des « messages » côté Chat. */
  unite?: string;
}>) {
  const [ouvertManuel, setOuvert] = useState(false);
  if (archives.length === 0) return null;
  const ouvert = ouvertManuel || rechercheActive;
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost session-list__new"
        aria-expanded={ouvert}
        onClick={() => setOuvert((v) => !v)}
      >
        {ouvert ? "▾" : "▸"} Archives ({archives.length})
      </button>
      {ouvert && (
        <ul className="session-list">
          {archives.map((a) => (
            <li key={a.id} className="session-item">
              <button type="button" className="session-item__title" title={`Restaurer : ${a.title}`} onClick={() => restoreArchive(a.id)}>
                {a.title}
              </button>
              <div className="session-item__meta">
                <span className="session-item__date">{formatRelativeDate(a.updatedAt)}</span>
                <span className="session-item__engine">{a.nbTours} {unite}</span>
              </div>
              <div className="session-item__actions">
                <button
                  type="button"
                  className="session-item__action"
                  title="Mettre de côté (non détruite)"
                  aria-label={`Mettre de côté ${a.title}`}
                  onClick={() => trashArchive(a.id)}
                >
                  🗑
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
