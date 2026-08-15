/*
 * T-032 — Sélecteur de modèle : toute la décision, aucun DOM.
 *
 * ── Pourquoi ce module existe ──────────────────────────────────────────
 * Le sélecteur du Chat et celui des Projets étaient des `<select>` natifs
 * nourris par `models.list`, qui ne rend que des ids : plusieurs centaines de
 * slugs bruts, dans l'ordre où OpenRouter les sert, sans prix ni contexte, et
 * les favoris listés DEUX fois (leur groupe, puis « Tous les modèles »). Un
 * `<select>` ne se filtre pas — rendre la liste navigable imposait d'en
 * sortir, donc d'écrire du composant. Tout ce qui peut se décider sans fenêtre
 * se décide ici, pour être testé sans fenêtre.
 *
 * ── Deux règles de non-perte, à ne pas relâcher ────────────────────────
 * 1. Une variante (`…:free`, `…:thinking`) n'est masquée QUE si son modèle de
 *    base est présent dans le même catalogue. `liquid/lfm-2.5-2.6b:free` n'a
 *    pas d'équivalent payant : le masquer ferait disparaître le modèle, pas
 *    son doublon.
 * 2. Le modèle SÉLECTIONNÉ échappe au masquage des variantes. Un filtre actif
 *    par défaut n'a pas le droit de rendre invisible le choix courant — sinon
 *    le sélecteur affiche « — » sur une conversation qui tourne très bien.
 *
 * Le filtre « gratuit », lui, est demandé explicitement : il s'applique sans
 * exception, y compris au modèle courant.
 */
import { fuzzyScore } from "./fuzzy";
import { sortModels, splitFeatured, type ModelSortKey } from "./modelCatalog";
import type { ModelDetail } from "./sidecar";

/* ---------- Ordre des éditeurs : part de trafic (curatée, datée) ---------- */

/**
 * Avertissement à afficher partout où cet ordre se voit. Même doctrine que
 * `BENCH_DISCLAIMER` (modelCatalog.ts) : un repère écrit à la main, pas un flux.
 */
export const TRAFIC_DISCLAIMER =
  "Éditeurs ordonnés par part de trafic OpenRouter (relevé de juin 2026) — repère figé, pas un flux temps réel.";

/**
 * Éditeurs par part de trafic DÉCROISSANTE, relevé de juin 2026.
 *
 * ── Provenance ─────────────────────────────────────────────────────────
 * Parts de tokens hebdomadaires du classement OpenRouter, telles que reprises
 * par des analyses tierces (juin 2026) : deepseek 17,6 % · anthropic 14,8 % ·
 * google 12,5 % · openai 8,4 % · xiaomi 8,3 % · minimax 8,1 % · tencent 8,1 % ·
 * qwen 4,3 %, plus moonshotai (~4,1 %) vu au relevé d'avril 2026.
 *
 * ── Pourquoi une liste FIGÉE, et courte ────────────────────────────────
 * Ce classement bouge vite et fort : entre les relevés d'avril et de juin
 * 2026, xiaomi passe de 22,3 % à 8,3 % et deepseek de 6,8 % à 17,6 %. Deux
 * conséquences assumées. D'abord la liste est datée et affichée comme telle,
 * jamais présentée comme l'état du jour. Ensuite elle s'arrête aux éditeurs
 * pour lesquels un chiffre existe : les cinquante autres du catalogue (x-ai,
 * mistralai, meta-llama, z-ai, nvidia…) passent APRÈS, par ordre alphabétique.
 * Les classer au jugé serait inventer une hiérarchie que rien ne mesure.
 *
 * Les slugs sont ceux du catalogue OpenRouter (`GET /api/v1/models`, relevé du
 * 2026-08-12 : 410 modèles, 59 éditeurs).
 */
export const RANG_EDITEURS: readonly string[] = [
  "deepseek",
  "anthropic",
  "google",
  "openai",
  "xiaomi",
  "minimax",
  "tencent",
  "qwen",
  "moonshotai",
];

const RANGS = new Map(RANG_EDITEURS.map((editeur, i) => [editeur, i]));

/** Rang de trafic de l'éditeur, `Infinity` s'il n'est pas dans le relevé. */
export function rangEditeur(editeur: string): number {
  return RANGS.get(editeur) ?? Infinity;
}

/** `anthropic/claude-sonnet-5` → `anthropic`. `""` si l'id ne nomme pas d'éditeur. */
export function editeurDe(id: string): string {
  const barre = id.indexOf("/");
  if (barre <= 0) return "";
  // Certains catalogues préfixent l'éditeur (`~google/…`) : bruit d'affichage,
  // jamais retiré de l'id lui-même — c'est l'id qui part au fournisseur.
  return id.slice(0, barre).replace(/^[~@]/, "");
}

/**
 * Modèle de base d'une variante : `nvidia/nemotron:free` → `nvidia/nemotron`.
 * `null` si l'id ne porte pas de suffixe. Le `:` est le séparateur de variante
 * chez OpenRouter (`:free`, `:thinking`, `:nitro`, `:extended`…).
 */
export function baseDeVariante(id: string): string | null {
  const deuxPoints = id.lastIndexOf(":");
  return deuxPoints > 0 ? id.slice(0, deuxPoints) : null;
}

/** Suffixe de variante sans le `:` (`free`, `thinking`…), `null` si l'id n'en porte pas. */
export function suffixeVariante(id: string): string | null {
  const deuxPoints = id.lastIndexOf(":");
  return deuxPoints > 0 ? id.slice(deuxPoints + 1) : null;
}

/**
 * Gratuit = les DEUX tarifs sont connus ET nuls. Un modèle sans tarif publié
 * n'est pas gratuit, il est inconnu (même doctrine que `sortModels`, qui range
 * l'inconnu en fin de liste plutôt qu'en tête du moins cher).
 */
export function estGratuit(model: ModelDetail): boolean {
  return model.pricing?.promptUsdPerM === 0 && model.pricing?.completionUsdPerM === 0;
}

export interface FiltreModeles {
  /** Recherche floue sur le nom ET l'id (sous-séquence, voir fuzzy.ts). */
  recherche: string;
  tri: ModelSortKey;
  /** `false` (défaut) : les variantes doublonnant un modèle de base sont masquées. */
  variantes: boolean;
  gratuitSeulement: boolean;
  /**
   * T-025 — la recherche web R9 est active : les agents qui cherchent DÉJÀ par
   * eux-mêmes sont écartés. Ce n'est pas une préférence d'affichage, c'est un
   * garde-fou (voir `estAgentRechercheIntegree`).
   */
  rechercheWebActive: boolean;
}

export const FILTRE_INITIAL: FiltreModeles = {
  recherche: "",
  tri: "name",
  variantes: false,
  gratuitSeulement: false,
  rechercheWebActive: false,
};

/**
 * Un agent qui fait la recherche web LUI-MÊME (`…-with-search`) ?
 *
 * ── Pourquoi les écarter quand R9 est active (T-025) ────────────────────
 * Mesuré le 2026-08-11 : `gemini-pro-with-search` rend la phrase d'erreur du
 * fournisseur dans 2 tours sur 6, à requête strictement identique, alors que
 * le modèle brut équivalent réussit 6 fois sur 6. Ni l'historique, ni le bloc
 * système de R9, ni la taille du corps n'expliquent l'écart : c'est l'agent de
 * recherche du fournisseur qui casse. Quand R9 est active, la recherche est
 * faite DEUX fois — une fois par nous, avec nos sources citées, une fois par
 * l'agent — et c'est la seconde qui échoue.
 *
 * Le ticket a écarté les autres pistes : valider les modèles par un appel court
 * ne rattrape pas un modèle qui répond 9 fois sur 10, et la consommation à zéro
 * ne distingue pas le tour échoué du tour réussi. Écarter ces agents-là quand
 * on cherche déjà pour eux est le seul correctif qui vise la cause.
 *
 * Reconnaissance par l'id, faute de mieux : le fournisseur n'expose aucun trait
 * disant « cet agent cherche ». C'est exactement ce que T-023 doit supprimer —
 * en attendant, la devinette est ici, nommée, testée, et à un seul endroit.
 */
export function estAgentRechercheIntegree(id: string): boolean {
  return /-with-search\b/i.test(id);
}

export interface GroupeEditeur {
  /** Slug de l'éditeur (`anthropic`, `meta-llama`…). `""` = ids sans éditeur (Ollama). */
  editeur: string;
  models: ModelDetail[];
}

export interface ListeModeles {
  /** Favoris survivant au filtre, dans l'ORDRE D'AJOUT (pas celui du tri). */
  favoris: ModelDetail[];
  /** Tout le reste, groupé par éditeur — sans jamais répéter un favori. */
  groupes: GroupeEditeur[];
  /** Variantes écartées, pour le dire à l'utilisateur au lieu de les escamoter. */
  variantesMasquees: number;
  /** Agents à recherche intégrée écartés par R9 (T-025) — se DIT, ne s'escamote pas. */
  agentsRechercheMasques: number;
  /** Nombre de modèles affichés, pour distinguer « rien ne matche » de « catalogue vide ». */
  total: number;
}

/**
 * Groupe une liste DÉJÀ TRIÉE par éditeur, sans retrier les modèles.
 *
 * Deux ordres, deux responsabilités qui ne se marchent pas dessus :
 *  - l'ordre des GROUPES est celui du trafic (`RANG_EDITEURS`), les éditeurs
 *    hors relevé ensuite par ordre alphabétique, et les ids sans éditeur
 *    (Ollama) toujours en dernier ;
 *  - l'ordre DANS un groupe est celui reçu, donc celui du tri choisi par
 *    l'utilisateur (nom, prix, contexte).
 *
 * Autrement dit : « chez qui » ne dépend pas du tri, « lequel » en dépend
 * entièrement. Changer de tri ne fait donc jamais sauter les éditeurs de place
 * sous le curseur.
 */
export function grouperParEditeur(models: ModelDetail[]): GroupeEditeur[] {
  const groupes: GroupeEditeur[] = [];
  const parEditeur = new Map<string, GroupeEditeur>();
  for (const model of models) {
    const editeur = editeurDe(model.id);
    let groupe = parEditeur.get(editeur);
    if (!groupe) {
      groupe = { editeur, models: [] };
      parEditeur.set(editeur, groupe);
      groupes.push(groupe);
    }
    groupe.models.push(model);
  }
  return groupes.sort((a, b) => {
    // Sans éditeur = fourre-tout : après tout le monde, y compris les inconnus.
    if (a.editeur === "" || b.editeur === "") return a.editeur === "" ? 1 : -1;
    const rang = rangEditeur(a.editeur) - rangEditeur(b.editeur);
    // `Infinity - Infinity` est NaN : deux éditeurs hors relevé se départagent
    // alphabétiquement, jamais par un comparateur qui rend NaN (tri instable).
    return Number.isNaN(rang) || rang === 0 ? a.editeur.localeCompare(b.editeur) : rang;
  });
}

/**
 * Filtre, trie et groupe le catalogue pour le sélecteur.
 *
 * L'ordre est TOUJOURS celui de `filtre.tri`, y compris pendant une recherche :
 * la pertinence floue sert à retenir des lignes, pas à les réordonner. Trier
 * par prix puis taper trois lettres ne doit pas rendre la liste au hasard.
 */
export function construireListe(
  models: ModelDetail[],
  favoris: string[],
  filtre: FiltreModeles,
  valeurCourante: string,
): ListeModeles {
  const idsConnus = new Set(models.map((m) => m.id));
  let variantesMasquees = 0;
  let agentsRechercheMasques = 0;

  const retenus = models.filter((m) => {
    // Même règle de non-perte que pour les variantes : le modèle SÉLECTIONNÉ
    // ne disparaît jamais, sinon le sélecteur affiche « — » sur une
    // conversation qui tourne.
    if (filtre.rechercheWebActive && m.id !== valeurCourante && estAgentRechercheIntegree(m.id)) {
      agentsRechercheMasques += 1;
      return false;
    }
    if (!filtre.variantes && m.id !== valeurCourante) {
      const base = baseDeVariante(m.id);
      if (base !== null && idsConnus.has(base)) {
        variantesMasquees += 1;
        return false;
      }
    }
    if (filtre.gratuitSeulement && !estGratuit(m)) return false;
    const q = filtre.recherche.trim();
    if (q && fuzzyScore(`${m.name ?? ""} ${m.id}`, q) === null) return false;
    return true;
  });

  const favorisRetenus = splitFeatured(retenus, favoris);
  const idsFavoris = new Set(favorisRetenus.map((m) => m.id));
  const autres = sortModels(
    retenus.filter((m) => !idsFavoris.has(m.id)),
    filtre.tri,
  );

  return {
    favoris: favorisRetenus,
    groupes: grouperParEditeur(autres),
    variantesMasquees,
    agentsRechercheMasques,
    total: favorisRetenus.length + autres.length,
  };
}

/**
 * Modèles dans l'ordre où ils sont RENDUS (favoris, puis groupes d'éditeurs) :
 * c'est cet ordre que parcourent les flèches du clavier, et lui seul. Le
 * regroupement DÉPLACE des lignes — un même éditeur revient dans son groupe —
 * donc cet ordre n'est pas celui du tri, et c'est celui-ci qui fait foi.
 */
export function ordreAffichage(liste: ListeModeles): ModelDetail[] {
  return [...liste.favoris, ...liste.groupes.flatMap((g) => g.models)];
}
