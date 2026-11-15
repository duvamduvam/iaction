/*
 * Section « En attente de vous (n) » du panneau latéral droit (T-181) : les
 * questions d'agent et demandes de permission qui attendent une réponse, tous
 * projets confondus. Visible dès qu'il y en a une ; un clic rouvre la modale
 * (en basculant sur le bon projet/la bonne conversation si besoin).
 *
 * Vit hors de agentSidebarDroit.tsx, qui touche déjà le plafond de lignes.
 */

import { libelleLigne, titreSectionAttente, type LigneAttente } from "./demandesEnAttente";
import type { PermissionRequestItem } from "./questionsAgent";
import { SidebarSection } from "./SidebarSection";

export function EnAttenteSection({
  lignes,
  onOuvrir,
}: Readonly<{
  lignes: readonly LigneAttente[];
  onOuvrir: (item: PermissionRequestItem) => void;
}>) {
  if (lignes.length === 0) return null;
  return (
    <SidebarSection
      id="en-attente"
      title={titreSectionAttente(lignes.length)}
      defaultOpen
    >
      <ul className="attente-liste">
        {lignes.map((l) => (
          <li key={l.cle}>
            <button
              type="button"
              className="attente-ligne"
              title={`${libelleLigne(l)} — cliquer pour répondre`}
              onClick={() => onOuvrir(l.item)}
            >
              <span className="attente-ligne__type">{l.type === "question" ? "Question" : "Permission"}</span>
              <span>{l.titre}</span>
              <span className="attente-ligne__lieu">
                {l.projet} · {l.conversation}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SidebarSection>
  );
}
