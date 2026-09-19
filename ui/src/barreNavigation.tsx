/*
 * La barre de navigation principale — les six onglets de pages, et les actions
 * qui ne sont PAS des onglets (terminal, nouvelle fenêtre).
 *
 * Extraite d'App.tsx en payant le cliquet de taille de T-062 : la barre ne
 * dépend que de la page active et de deux rappels, elle n'avait aucune raison
 * de vivre au milieu des encarts de conso et de la sonde système.
 */
import { invoke } from "@tauri-apps/api/core";
import { logWarn } from "./journal";
import { NAV_ITEMS, type PageId } from "./navigation";
import { useRovingFocus } from "./useRovingFocus";

/**
 * T-062 — deuxième fenêtre, MÊME processus et MÊME sidecar : un seul CLI, un
 * seul gestionnaire de timers, une seule configuration (voie A de
 * `docs/etude-deux-projets.md`). La coquille choisit l'étiquette et câble le
 * micro et la surveillance de webview ; ici il n'y a qu'à demander.
 *
 * Hors composant, donc appelable sans plomberie de props par le bouton de la
 * barre comme par le raccourci Ctrl+Maj+N (App.tsx). Échec journalisé, jamais
 * tu : une fenêtre qui ne s'ouvre pas est indiscernable d'un clic manqué.
 */
export function ouvrirNouvelleFenetre(): void {
  void invoke("fenetre_ouvrir").catch((err: unknown) => {
    logWarn("ui", "ouverture d'une nouvelle fenêtre impossible", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
  });
}

export function Nav({
  active,
  onSelect,
  onOpenTerminal,
  orchestrationAlert,
}: Readonly<{
  active: PageId;
  onSelect: (id: PageId) => void;
  onOpenTerminal: () => void;
  /** Libellé du dernier rapport de tâche non vu (null = rien à signaler) — pastille sur l'onglet Orchestration. */
  orchestrationAlert: string | null;
}>) {
  // Roving tabindex : ←/→ (et Début/Fin) parcourent la barre, Entrée ou Espace
  // active — se DÉPLACER ne change pas de page (activation manuelle, APG). Les
  // boutons d'action font partie du parcours : ils sont dans la barre, et les
  // en sortir laisserait des arrêts de tabulation isolés au bout du menu.
  const roving = useRovingFocus<HTMLElement>({ selector: ".nav-item", orientation: "horizontal" });
  return (
    <nav
      className="app-nav"
      aria-label="Navigation principale"
      ref={roving.containerRef}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {NAV_ITEMS.map((item) => {
        const alerted = item.id === "orchestration" && orchestrationAlert !== null;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-item${active === item.id ? " nav-item--active" : ""}${alerted ? " nav-item--alert" : ""}`}
            onClick={() => onSelect(item.id)}
            aria-current={active === item.id ? "page" : undefined}
            tabIndex={active === item.id ? 0 : -1}
            title={alerted ? `Nouveau rapport de tâche : ${orchestrationAlert}` : undefined}
          >
            {item.label}
          </button>
        );
      })}
      {/* Action (pas un onglet) : lance un terminal système — dans le projet
          en cours quand la vue Projets est active, sinon dans le home. */}
      <button
        type="button"
        className="nav-item nav-item--action"
        onClick={onOpenTerminal}
        tabIndex={-1}
        title="Ouvrir un terminal (dans le projet en cours depuis la vue Projets)"
      >
        Terminal
      </button>
      {/* Action (pas un onglet) : une seconde fenêtre, sur un AUTRE projet
          (T-062) — un projet déjà ouvert ailleurs ne s'ouvre pas deux fois,
          c'est sa fenêtre qui passe devant. */}
      <button
        type="button"
        className="nav-item nav-item--action"
        onClick={ouvrirNouvelleFenetre}
        tabIndex={-1}
        title="Ouvrir une nouvelle fenêtre, pour travailler sur un second projet (Ctrl+Maj+N)"
      >
        Nouvelle fenêtre
      </button>
    </nav>
  );
}
