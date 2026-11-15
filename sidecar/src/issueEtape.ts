/*
 * Issue d'une étape d'orchestration à partir du `done` du moteur.
 *
 * Sorti d'orchestrator.ts (sous dérogation du cliquet) à l'occasion de T-153 :
 * c'est une règle pure, qui se teste sans lancer d'orchestration.
 */

/**
 * T-153 — le CLI rend parfois une erreur d'API (réseau, DNS, certificat) comme
 * TEXTE de résultat, avec un subtype `success` : « API Error: Unable to connect
 * to API… ». Prise pour une réussite, l'étape ne laissait aucune trace d'échec
 * (la veille des modèles est restée « success » deux jours de suite sans avoir
 * rien joué). Le préfixe est celui du CLI ; les espaces de tête sont tolérés.
 */
const PREFIXE_ERREUR_API = /^\s*API Error:/;

/** Une ligne, 200 caractères au plus : l'extrait cité dans le message d'échec. */
function extrait(sortie: string): string {
  const ligne = sortie.trim().replace(/\s+/g, " ");
  return ligne.length > 200 ? `${ligne.slice(0, 200)}…` : ligne;
}

/**
 * Classe le `done` d'une étape moteur (subtype claude/neutral) en issue d'étape.
 * `sortie` est le texte final de l'étape (voir `extractStepOutput`).
 */
export function classifyStepOutcome(
  doneData: Record<string, unknown>,
  sortie: string = "",
): {
  status: "success" | "failed" | "aborted";
  message?: string;
} {
  const subtype = typeof doneData.subtype === "string" ? doneData.subtype : "unknown";
  if (subtype === "aborted") {
    // T-076 — "failed" pose toujours un message, "aborted" n'en posait
    // aucun : la même étape interrompue restait muette dans le rapport final
    // (orch.run done, `steps[id].message`) alors que sa jumelle en échec disait
    // pourquoi. Le tour lui-même sait la vraie raison (arrêt, refus…) — voir
    // claudeFinDeTour.ts — mais ce niveau-ci n'en reçoit que le subtype.
    return { status: "aborted", message: `étape interrompue (subtype: ${subtype})` };
  }
  if (subtype === "success" || subtype === "max_turns") {
    if (PREFIXE_ERREUR_API.test(sortie)) {
      return { status: "failed", message: `échec de l'API (subtype: ${subtype}) : ${extrait(sortie)}` };
    }
    return { status: "success" };
  }
  return { status: "failed", message: `échec du moteur (subtype: ${subtype})` };
}
