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
 * ── L'étage se DÉDUIT du prix, jamais du nom ─────────────────────────────
 * `claude-opus-4-8` et `claude-opus-5` sont au même tarif, `fable-5` aussi —
 * les ranger « à l'œil » par le nom sera faux à la prochaine sortie (§7.1).
 * L'étage est donc calculé depuis le TAUX RÉEL du modèle sur la période
 * (`costUsd / tokens`, déjà agrégé par `usageSobriete.ts`), jamais depuis un
 * catalogue statique qui pourrirait. Un modèle gratuit (Ollama, tarif nul)
 * tombe naturellement dans « local et scripts » : sa classification n'a rien
 * à deviner, son coût réel EST zéro.
 */
import type { UsageSobriete } from "./usageStatsClient";

export type Etage = "gros" | "petitPayant" | "mecanique" | "local";

/** Ordre d'affichage : du plus cher au moins cher, cohérent avec le nom « pyramide ». */
export const ORDRE_ETAGES: readonly Etage[] = ["gros", "petitPayant", "mecanique", "local"];

export const LIBELLE_ETAGE: Record<Etage, string> = {
  gros: "Gros modèles",
  petitPayant: "Petit payant",
  mecanique: "Mécanique",
  local: "Local et scripts",
};

/**
 * Bornes cibles du skill `sobriete`, RELUES EN COÛT (§7.1) : elles étaient
 * écrites en part de TOKENS ; appliquées telles quelles à la part de COÛT,
 * elles restent le seul repère qu'on ait — mais elles mesurent désormais ce
 * qui a réellement été payé (ou son équivalent), pas un volume qui flatte.
 */
export const BORNES_ETAGE: Record<Etage, { min: number; max: number }> = {
  gros: { min: 10, max: 20 },
  petitPayant: { min: 50, max: 60 },
  mecanique: { min: 5, max: 10 },
  local: { min: 20, max: 30 },
};

/**
 * Seuils de $/M tokens qui séparent les étages — ordres de grandeur mi-2026
 * (haiku ≈ 1-5 $/M, sonnet ≈ 3-15 $/M, opus/fable ≈ 15-75 $/M) : les deux
 * seuils tombent entre les familles, pas dedans. Ce sont des CONSTANTES, pas
 * un catalogue de prix par modèle — ils ne pourrissent pas à chaque sortie.
 */
const SEUIL_MECANIQUE_USD_PAR_M = 3;
const SEUIL_GROS_USD_PAR_M = 12;

function classer(tauxUsdParMillionTokens: number): Etage {
  if (tauxUsdParMillionTokens <= 0) return "local";
  if (tauxUsdParMillionTokens < SEUIL_MECANIQUE_USD_PAR_M) return "mecanique";
  if (tauxUsdParMillionTokens < SEUIL_GROS_USD_PAR_M) return "petitPayant";
  return "gros";
}

export interface LignePyramide {
  etage: Etage;
  costUsd: number;
  tokens: number;
  /** Part de l'étage dans le coût TOTAL de la période ventilée — jamais dans les tokens. */
  pctCout: number;
  borne: { min: number; max: number };
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
    const taux = (m.costUsd / m.tokens) * 1_000_000;
    const etage = classer(taux);
    const cur = parEtage.get(etage) ?? { costUsd: 0, tokens: 0 };
    cur.costUsd += m.costUsd;
    cur.tokens += m.tokens;
    parEtage.set(etage, cur);
  }

  const coutTotalUsd = [...parEtage.values()].reduce((s, v) => s + v.costUsd, 0);
  const lignes: LignePyramide[] = ORDRE_ETAGES.map((etage) => {
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
      dansLaBorne: pctCout >= borne.min && pctCout <= borne.max,
    };
  });

  return { lignes, coutTotalUsd };
}
