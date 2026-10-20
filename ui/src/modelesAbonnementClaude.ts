/*
 * Les modèles de l'abonnement Claude — une seule liste, trois consommateurs.
 *
 * ── Pourquoi une liste en dur ───────────────────────────────────────────
 * Contrairement aux fournisseurs neutres, l'abonnement Claude n'expose aucun
 * catalogue interrogeable : le CLI ne rend pas la liste des modèles auxquels
 * l'abonnement donne droit. On la maintient donc à la main, et on l'épingle
 * dans les sélecteurs pour qu'elle échappe aux filtres du catalogue neutre
 * (T-032).
 *
 * ── Pourquoi ELLE VIT ICI ───────────────────────────────────────────────
 * Elle était recopiée dans trois fichiers — le sélecteur des projets, celui
 * du Chat, et la table des fenêtres de contexte. Le 2026-08-13, `claude-opus-5`
 * était sorti depuis un moment et ne figurait dans aucun des trois : une liste
 * à recopier est une liste qu'on oublie de mettre à jour (T-046). Un seul
 * endroit, donc, et les trois consommateurs en dérivent.
 *
 * Tenir à jour : ordre du plus capable au plus économique — c'est l'ordre
 * d'affichage dans les sélecteurs.
 *
 * ── Pourquoi la fenêtre de contexte vit ICI aussi (T-141) ──────────────
 * Elle était en dur dans contextBus.ts, au palier unique de 200 k pour TOUS
 * les modèles de l'abonnement. C'est faux depuis la génération 4.6 : Fable,
 * Opus 5 et Sonnet 5 sont à 1 M, seul Haiku 4.5 est resté à 200 k. La jauge
 * d'un fil affichait donc cinq fois trop, jusqu'à ce qu'un prompt dépassant
 * 200 k déclenche le rattrapage. Le modèle et sa fenêtre sont UN SEUL fait :
 * ils se déclarent au même endroit, et on ne peut plus en oublier la moitié.
 *
 * Ce qui SORT de la liste ne casse rien : un fil déjà épinglé sur un modèle
 * retiré affiche toujours son id et continue de tourner (ModelPicker retombe
 * sur la valeur brute) — il ne peut simplement plus être resélectionné.
 * `claude-opus-4-8` est sorti ainsi le 2026-08-13 : même tarif qu'Opus 5 pour
 * une génération de moins, il n'avait plus de raison d'occuper une ligne.
 * `claude-fable-5` est sorti de même le 2026-09-19, remplacé par
 * `claude-fable-5-1` : même tarif, même étage, une génération de plus (T-142).
 * `claude-opus-5` est sorti le 2026-09-26, remplacé par `claude-opus-5-5`
 * (sorti le 2026-09-22) : MOINS cher ($4/$20 contre $5/$25) et meilleur — il
 * rejoint Fable 5.1 sur la plupart des bancs d'essai (T-143).
 * `claude-sonnet-5` est sorti le 2026-10-06, remplacé par `claude-sonnet-5-5`
 * (sorti le 2026-09-28) : même tarif ($2/$10), une génération de plus, plus
 * rapide en sortie et plus sobre en tokens (T-143).
 *
 * AVANT d'ajouter un id ici : vérifier qu'il existe dans le binaire que le
 * sidecar lance vraiment, et qui n'est PAS le `claude` installé sur la machine
 * (voir cliClaude.ts) —
 *   strings node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude | grep <id>
 * Le catalogue public d'Anthropic et ce que le runtime sait servir ne sont pas
 * la même liste : le 2026-09-19, `claude-fable-5-1` existait depuis un moment
 * au catalogue et manquait encore au CLI embarqué par l'agent SDK 0.3.214.
 */

/** Niveau d'effort de raisonnement (`Options.effort` du SDK), du plus sobre au plus poussé. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Les niveaux, dans l'ordre d'affichage. */
export const NIVEAUX_EFFORT: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Un modèle de l'abonnement, tel qu'on le propose à l'utilisateur. */
export interface ModeleAbonnement {
  /** Identifiant exact passé au CLI (jamais de suffixe de date). */
  id: string;
  /**
   * Fenêtre de contexte en tokens, telle que le catalogue Anthropic l'annonce
   * pour ce modèle. C'est un PALIER de départ, pas une vérité : l'abonnement
   * peut servir moins, et `contextWindowFor` recale vers le haut si l'API
   * accepte un prompt plus grand.
   */
  contexte: number;
  /** Niveaux d'effort que le modèle supporte — liste vide : pas de réglage d'effort. */
  efforts: EffortLevel[];
  /** Ce qu'on en dit dans le sélecteur, quand ce n'est pas évident. */
  note?: string;
}

export const MODELES_ABONNEMENT_CLAUDE: ModeleAbonnement[] = [
  {
    id: "claude-fable-5-1",
    contexte: 1_000_000,
    efforts: NIVEAUX_EFFORT,
    note: "Le plus capable — raisonnement long, travail agentique",
  },
  {
    id: "claude-opus-5-5",
    contexte: 1_000_000,
    efforts: NIVEAUX_EFFORT,
    note: "Opus courant — niveau Fable sur la plupart des tâches, 2,5× moins cher",
  },
  {
    id: "claude-sonnet-5-5",
    contexte: 1_000_000,
    efforts: NIVEAUX_EFFORT,
    note: "Sonnet courant — même tarif que Sonnet 5, plus rapide et plus sobre en tokens",
  },
  { id: "claude-haiku-4-5", contexte: 200_000, efforts: [], note: "Le plus rapide et le plus économique" },
];

/** Ids seuls — pour les consommateurs qui n'ont que faire des libellés. */
export const IDS_ABONNEMENT_CLAUDE: string[] = MODELES_ABONNEMENT_CLAUDE.map((m) => m.id);

/**
 * Niveaux d'effort proposables pour un modèle. Modèle inconnu, vide ou
 * non-Claude (moteur neutre) : aucun — on ne devine pas ce qu'on ne connaît pas.
 */
export function effortsPour(modelId: string | null | undefined): EffortLevel[] {
  return MODELES_ABONNEMENT_CLAUDE.find((m) => m.id === modelId)?.efforts ?? [];
}
