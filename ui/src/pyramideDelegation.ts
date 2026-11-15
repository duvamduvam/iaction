/*
 * T-071 — pyramide de délégation, pondérée par le COÛT ÉQUIVALENT API, pas
 * par les tokens (docs/etude-supervision.md §7.1, « reste à faire »).
 *
 * ── Pourquoi les tokens flattent ─────────────────────────────────────────
 * Mesuré sur 30 jours (§7.1) : la pyramide en tokens annonçait 61 % de gros
 * modèles, 39 % de petits/locaux — un tiers gratuit y comptait comme un tiers
 * de gros. En coût, c'est 99,4 % / 0,6 % : un token d'opus vaut 15 à 75 fois
 * un token de haiku ou de sonnet, et le tiers local pèse exactement ZÉRO dans
 * la facture. Pondérer par les tokens aurait affiché des progrès qui n'existent
 * pas — basculer une tâche de fable vers sonnet déplace 5× plus de barre en
 * coût qu'en tokens.
 *
 * ── L'étage se DÉDUIT de la FAMILLE du modèle (T-201) ────────────────────
 * Décision de David (2026-11-08) : plus de seuils de $/M tokens — ils
 * périmaient à chaque grille tarifaire (Sonnet 5.5 à 2/10 $ passait sous le
 * seuil « mécanique », Opus 5.5 à 4/20 $ sous le seuil « gros »). On range par
 * famille reconnue dans l'id : Haiku et Sonnet en bas, Opus au milieu, Fable en
 * haut. Un modèle sans famille reconnue n'est JAMAIS deviné : gratuit (coût
 * réel nul, Ollama…) il va en « local et scripts », payant il va en « non
 * classé » — visible, pas dissimulé dans un étage au hasard.
 */
import type { UsageSobriete } from "./usageStatsClient";

export type Etage = "gros" | "petitPayant" | "mecanique" | "local" | "nonClasse";

/** Ordre d'affichage : du plus cher au moins cher, cohérent avec le nom « pyramide ». */
export const ORDRE_ETAGES: readonly Etage[] = ["gros", "petitPayant", "mecanique", "local", "nonClasse"];

export const LIBELLE_ETAGE: Record<Etage, string> = {
  gros: "Haut · Fable",
  petitPayant: "Milieu · Opus",
  mecanique: "Bas · Haiku, Sonnet",
  local: "Local et scripts",
  nonClasse: "Non classé",
};

/**
 * Bornes cibles du skill `sobriete`, RELUES EN COÛT (§7.1) : elles étaient
 * écrites en part de TOKENS ; appliquées telles quelles à la part de COÛT,
 * elles restent le seul repère qu'on ait — mais elles mesurent désormais ce
 * qui a réellement été payé (ou son équivalent), pas un volume qui flatte.
 */
export const BORNES_ETAGE: Record<Etage, { min: number; max: number } | null> = {
  gros: { min: 10, max: 20 },
  petitPayant: { min: 50, max: 60 },
  mecanique: { min: 5, max: 10 },
  local: { min: 20, max: 30 },
  // Pas de cible pour ce qu'on n'a pas su ranger : le but est de le voir fondre.
  nonClasse: null,
};

const FAMILLES: ReadonlyArray<{ motif: string; etage: Etage }> = [
  { motif: "fable", etage: "gros" },
  { motif: "opus", etage: "petitPayant" },
  { motif: "sonnet", etage: "mecanique" },
  { motif: "haiku", etage: "mecanique" },
];

/**
 * Étage d'un modèle d'après la famille lue dans son id (`claude-opus-5`,
 * `anthropic/claude-sonnet-5-5`…). Deux familles dans le même id (ambigu) ou
 * aucune : pas de famille, l'appelant décide — on ne devine pas.
 */
function etageParFamille(modele: string): Etage | null {
  const id = modele.toLowerCase();
  const trouves = new Set(FAMILLES.filter((f) => id.includes(f.motif)).map((f) => f.motif));
  if (trouves.size !== 1) return null;
  return FAMILLES.find((f) => trouves.has(f.motif))?.etage ?? null;
}

function classer(modele: string, costUsd: number): Etage {
  const parFamille = etageParFamille(modele);
  if (parFamille) return parFamille;
  return costUsd <= 0 ? "local" : "nonClasse";
}

export interface LignePyramide {
  etage: Etage;
  costUsd: number;
  tokens: number;
  /** Part de l'étage dans le coût TOTAL de la période ventilée — jamais dans les tokens. */
  pctCout: number;
  borne: { min: number; max: number } | null;
  dansLaBorne: boolean;
}

export interface Pyramide {
  lignes: LignePyramide[];
  coutTotalUsd: number;
}

/**
 * `null` si `parModeleReel` est vide (aucun tour ventilé) — l'appelant doit
 * alors afficher qu'il attend la ventilation T-066, pas une pyramide à zéro
 * (un zéro et une absence de mesure ne se confondent jamais).
 */
export function calculerPyramide(parModeleReel: UsageSobriete["parModeleReel"]): Pyramide | null {
  const utiles = parModeleReel.filter((m) => m.tokens > 0);
  if (utiles.length === 0) return null;

  const parEtage = new Map<Etage, { costUsd: number; tokens: number }>();
  for (const m of utiles) {
    const etage = classer(m.model, m.costUsd);
    const cur = parEtage.get(etage) ?? { costUsd: 0, tokens: 0 };
    cur.costUsd += m.costUsd;
    cur.tokens += m.tokens;
    parEtage.set(etage, cur);
  }

  const coutTotalUsd = [...parEtage.values()].reduce((s, v) => s + v.costUsd, 0);
  const lignes: LignePyramide[] = ORDRE_ETAGES.filter((e) => e !== "nonClasse" || parEtage.has(e)).map((etage) => {
    const v = parEtage.get(etage) ?? { costUsd: 0, tokens: 0 };
    // Tout est gratuit sur la période (coûtTotalUsd === 0) : chaque modèle
    // ayant alors un taux nul, seul l'étage « local » peut porter des tokens —
    // il en tient 100 %, les autres étages sont vides et affichent 0 %.
    const pctCout = coutTotalUsd > 0 ? (v.costUsd / coutTotalUsd) * 100 : v.tokens > 0 ? 100 : 0;
    const borne = BORNES_ETAGE[etage];
    return {
      etage,
      costUsd: v.costUsd,
      tokens: v.tokens,
      pctCout,
      borne,
      dansLaBorne: borne !== null && pctCout >= borne.min && pctCout <= borne.max,
    };
  });

  return { lignes, coutTotalUsd };
}
