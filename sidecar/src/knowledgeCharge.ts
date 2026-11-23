/*
 * Charge de l'indexation des connaissances (T-229) — deux feuilles pures.
 *
 * 1. `memeDate` : deux dates de modification désignent-elles le même état du
 *    fichier ? L'égalité stricte de deux flottants ne tient pas quand l'index a
 *    été écrit par un autre outil que ce sidecar : la même date en nanosecondes
 *    donne, selon le langage qui la convertit en millisecondes, des doubles qui
 *    diffèrent au dernier bit (1791489623352.0872 contre …352.0874). Constaté
 *    le 2026-11-22 : 50 fichiers sur 217 jugés « modifiés » à chaque ouverture,
 *    donc ré-embarqués pour rien. La tolérance est d'une milliseconde : aucun
 *    système de fichiers ne produit deux écritures distinctes plus proches que
 *    ça sans que la taille ou le contenu ne le montre par ailleurs.
 *
 * 2. `threadsEmbeddings` : nombre de fils que le serveur d'embeddings a le
 *    droit de prendre. Sans borne, Ollama occupe tous les cœurs : une
 *    indexation de quelques minutes faisait monter le processeur à 95 °C et
 *    gênait tout ce qui tournait à côté. Défaut : un quart des cœurs, entre 2
 *    et 8. `IACTION_EMBED_THREADS` le remplace (0 = laisser le serveur décider).
 */

/** Tolérance de comparaison des dates de modification, en millisecondes. */
export const TOLERANCE_DATE_MS = 1;

export function memeDate(connue: unknown, lue: number): boolean {
  return typeof connue === "number" && Number.isFinite(connue) && Math.abs(connue - lue) < TOLERANCE_DATE_MS;
}

/**
 * Fils alloués aux embeddings. Rend 0 quand aucune borne ne doit être envoyée
 * au serveur. Pur : `coeurs` et `env` sont fournis par l'appelant.
 */
export function threadsEmbeddings(coeurs: number, env: Record<string, string | undefined> = {}): number {
  const brut = env.IACTION_EMBED_THREADS;
  if (brut !== undefined && brut.trim() !== "") {
    const n = Number(brut);
    if (Number.isInteger(n) && n >= 0 && n <= 256) return n;
  }
  if (!Number.isFinite(coeurs) || coeurs < 1) return 2;
  return Math.min(8, Math.max(2, Math.floor(coeurs / 4)));
}
