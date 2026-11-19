/*
 * Câblage du chunk `reveil_demande` (T-219) : l'agent arme le réveil d'IAction.
 *
 * Sorti d'envoiProjet.ts (cliquet de taille). La décision pure vit dans
 * reveilAgent.ts ; ici, ce qui touche au monde : l'horloge, l'identifiant neuf,
 * le magasin de réouverture du quota, le runtime de la conversation et le
 * journal (canal `reveil`). Le réveil est persisté avec le reste à la fin du
 * tour (buildLiveSessions lit `reveils`).
 */

import { logInfo, logWarn } from "./journal";
import type { ReveilDemandeData } from "./protocole";
import { instantReouvertureQuota } from "./reouvertureQuota";
import { nouvelIdReveil } from "./reveil";
import { avecReveilDemande, reveilDepuisDemande } from "./reveilAgent";
import type { ConvRuntime } from "./modeleProjet";

export function traiterReveilDemande(
  demande: ReveilDemandeData,
  convId: string,
  compte: "perso" | "teams",
  updateRuntime: (convId: string, updater: (prev: ConvRuntime) => ConvRuntime) => void,
): void {
  const maintenant = Date.now();
  const ctx = { id: nouvelIdReveil(), maintenant, reouverture: instantReouvertureQuota(maintenant, compte) };
  updateRuntime(convId, (r) => avecReveilDemande(r, demande, ctx).runtime);
  // Verdict relu hors de l'updater (pur, même entrée) : le journal ne dépend pas du moment où React l'applique.
  const verdict = reveilDepuisDemande(demande, ctx);
  const champs = { convId, heures: demande.heures, surResetQuota: demande.surResetQuota, raison: demande.raison };
  if ("refus" in verdict) logWarn("reveil", "réveil demandé par l'agent non armé", { fields: { ...champs, refus: verdict.refus } });
  else logInfo("reveil", "réveil armé par l'agent", { fields: { ...champs, reveilId: ctx.id } });
}
