/*
 * T-191 — sélecteur « Perso / Teams » de la page Supervision. Rendu seulement
 * quand un compte `teams` est listé ; le nom du compte s'affiche hors perso.
 */
import type { CompteClaude, CompteDecrit } from "./comptesClaude";
import { nomCompteAffiche } from "./compteSupervision";

const CHOIX: { id: CompteClaude; label: string }[] = [
  { id: "perso", label: "Perso" },
  { id: "teams", label: "Teams" },
];

export function SelecteurCompte({
  compte,
  comptes,
  onChange,
}: Readonly<{ compte: CompteClaude; comptes: readonly CompteDecrit[] | null; onChange: (c: CompteClaude) => void }>) {
  const nom = nomCompteAffiche(compte, comptes);
  return (
    <div className="supervision-toolbar">
      <nav className="config-subnav" aria-label="Compte Claude">
        {CHOIX.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`config-subnav__item${compte === item.id ? " config-subnav__item--active" : ""}`}
            onClick={() => onChange(item.id)}
            aria-current={compte === item.id ? "true" : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {nom !== null && <span className="supervision-range-label">Compte : {nom}</span>}
    </div>
  );
}
