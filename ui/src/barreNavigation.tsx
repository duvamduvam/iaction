/*
 * La barre de navigation principale — les sept onglets de pages, et l'action
 * qui n'est PAS un onglet (terminal). Pas de bouton « nouvelle fenêtre » : une
 * seconde fenêtre s'ouvre en relançant IAction (instance unique, T-062).
 *
 * Extraite d'App.tsx en payant le cliquet de taille de T-062 : la barre ne
 * dépend que de la page active et de deux rappels, elle n'avait aucune raison
 * de vivre au milieu des encarts de conso et de la sonde système.
 */
import { NAV_ITEMS, type PageId } from "./navigation";
import { useRovingFocus } from "./useRovingFocus";

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
    </nav>
  );
}
