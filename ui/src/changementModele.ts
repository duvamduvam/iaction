/*
 * L'agent change lui-même de modèle et d'effort (T-207) — la logique pure du
 * bandeau « L'agent est passé à … · Annuler » et de la répercussion dans les
 * sélecteurs de la page Projets.
 *
 * Le sidecar a DÉJÀ appliqué le changement au moteur quand le chunk
 * `model_change` arrive (voir sidecar/src/changerModele.ts) : ici on ne fait
 * que mettre l'interface d'accord avec lui (pour que les tours suivants
 * partent sur le nouveau modèle) et garder de quoi l'ANNULER. Feuille pure,
 * testable sans page ni sidecar : le câblage vit dans envoiProjet.ts et
 * AgentPage.tsx.
 *
 * Hors périmètre, volontairement : le coût d'un tour à deux modèles. Le total
 * du tour reste affiché tel quel (docs/spec-changement-modele-auto.md § 3).
 */

import type { AgentTurn } from "./agentTurns";
import { effortsPour, NIVEAUX_EFFORT, type EffortLevel } from "./modelesAbonnementClaude";
import type { ModelChangeData } from "./protocole";

/** Un changement de modèle, tel que mémorisé sur le tour qui l'a vu naître (persisté avec lui). */
export interface ChangementModele {
  /** Modèle d'avant — ce que « Annuler » remet. */
  from: string;
  to: string;
  /** `""` = Défaut (rien posé), comme dans le sélecteur « Effort ». */
  effortFrom: EffortLevel | "";
  effortTo: EffortLevel | "";
  raison: string;
  /** Posé par « Annuler » : le bandeau reste comme trace, sans bouton. */
  annule?: boolean;
}

/** Ce que les deux sélecteurs du panneau LLM contiennent. */
export interface ChoixModele {
  model: string;
  effort: EffortLevel | "";
}

function effortOuDefaut(valeur: string | null): EffortLevel | "" {
  return (NIVEAUX_EFFORT as string[]).includes(valeur ?? "") ? (valeur as EffortLevel) : "";
}

/**
 * Chunk → changement mémorisable. `modeleDuTour` : modèle envoyé au départ du
 * tour, utilisé quand le sidecar ne savait pas encore quel modèle tournait
 * (`from` null, le tour n'avait pas encore parlé) — sans lui « Annuler »
 * n'aurait rien à remettre.
 */
export function changementDepuisChunk(chunk: ModelChangeData, modeleDuTour: string | null): ChangementModele | null {
  const from = chunk.from ?? modeleDuTour;
  if (!from) return null;
  return {
    from,
    to: chunk.to,
    effortFrom: effortOuDefaut(chunk.effortFrom),
    effortTo: effortOuDefaut(chunk.effortTo),
    raison: chunk.raison,
  };
}

/**
 * Réception : les sélecteurs prennent les valeurs d'arrivée. Un effort que le
 * nouveau modèle ne supporte pas retombe sur Défaut (même règle que l'effet de
 * la page sur le sélecteur « Effort »).
 */
export function choixApresChangement(c: ChangementModele): ChoixModele {
  return { model: c.to, effort: c.effortTo !== "" && effortsPour(c.to).includes(c.effortTo) ? c.effortTo : "" };
}

/** « Annuler » : les valeurs d'AVANT, dans les mêmes sélecteurs. */
export function choixApresAnnulation(c: ChangementModele): ChoixModele {
  return { model: c.from, effort: c.effortFrom !== "" && effortsPour(c.from).includes(c.effortFrom) ? c.effortFrom : "" };
}

/** « claude-opus-5-5 » → « Opus 5.5 » ; un identifiant inconnu est rendu tel quel. */
export function libelleModele(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!m) return id;
  const famille = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${famille} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

const LIBELLES_EFFORT: Record<EffortLevel, string> = {
  low: "faible",
  medium: "moyen",
  high: "élevé",
  xhigh: "très élevé",
  max: "maximal",
};

export function libelleEffort(effort: EffortLevel | ""): string {
  return effort === "" ? "par défaut" : LIBELLES_EFFORT[effort];
}

/**
 * Les morceaux du bandeau : « L'agent est passé à **Opus 5.5** · effort moyen —
 * *raison* ». La mise en forme (gras, italique) est celle du composant.
 */
export function morceauxBandeau(c: ChangementModele): { modele: string; effort: string | null; raison: string } {
  return {
    modele: libelleModele(c.to),
    // L'effort n'est dit que s'il a bougé ou s'il est posé : « effort par défaut » en bruit ne sert à personne.
    effort: c.effortTo !== "" || c.effortTo !== c.effortFrom ? `effort ${libelleEffort(c.effortTo)}` : null,
    raison: c.raison.trim(),
  };
}

/** Pose le changement sur le tour (le dernier changement écrase le précédent : un par tour suffit au bandeau). */
export function withChangementModele(turns: AgentTurn[], turnId: string, c: ChangementModele): AgentTurn[] {
  return turns.map((t) => (t.id === turnId ? { ...t, changementModele: c } : t));
}

/** Marque le bandeau comme annulé (le bouton disparaît, la trace reste). */
export function withChangementAnnule(turns: AgentTurn[], turnId: string): AgentTurn[] {
  return turns.map((t) =>
    t.id === turnId && t.changementModele ? { ...t, changementModele: { ...t.changementModele, annule: true } } : t,
  );
}

/**
 * Argument `effort` de la requête `claude.setModel` pour annuler : `undefined`
 * (ne pas toucher) si l'effort n'a pas bougé ; `null` (défaut du modèle) si
 * l'effort d'avant était le Défaut ; sinon le niveau d'avant.
 */
export function effortPourAnnulation(c: ChangementModele): EffortLevel | null | undefined {
  if (c.effortFrom === c.effortTo) return undefined;
  return c.effortFrom === "" ? null : c.effortFrom;
}
