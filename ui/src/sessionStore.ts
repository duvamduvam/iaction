/*
 * Petits utilitaires PARTAGÉS entre les historiques de sessions de la page
 * Projets (AgentPage.tsx, clé `project-conversations`) et de la page Chat
 * (ChatPage.tsx, clé `chat-conversations`) : chaque page garde son propre
 * schéma de persistance (les données qu'une session transporte diffèrent
 * complètement — tours d'agent + fichiers ouverts côté Projets, simples
 * messages côté Chat), mais la mécanique autour (identifiant, titre auto,
 * date relative affichée dans la liste, plafond du nombre de sessions
 * conservées) est identique — d'où ce module plutôt qu'une duplication.
 *
 * Aucune des fonctions ci-dessous ne touche à `stateRead`/`stateWrite` :
 * chaque page reste responsable de son propre chargement/sauvegarde et de
 * la validation défensive du document lu du disque (formes différentes).
 */

/** Champs communs à toute entrée d'historique, quelle que soit la page. */
export interface SessionMeta {
  id: string;
  title: string;
  /** `true` dès que l'utilisateur a renommé la session — le titre auto n'est alors plus jamais recalculé. */
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Squelette d'une session neuve (id, titre par défaut, horodatages) — à compléter par l'appelant avec ses champs propres. */
export function newSessionMeta(): SessionMeta {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "Nouvelle session", titleCustom: false, createdAt: now, updatedAt: now };
}

/**
 * Formules d'amorce françaises courantes en tête d'un premier message
 * (l'utilisateur tape vite, souvent sans accents) : elles n'apportent aucune
 * information au titre auto, donc on les retire. Variantes avec/sans trait
 * d'union incluses séparément (pas de tokenisation : on compare des
 * sous-chaînes, un trait d'union n'est pas une frontière de mot comme un
 * espace). Triée du plus long au plus court dans stripLeadingPhrase() pour
 * qu'un préfixe court ("fais") ne morde pas avant un préfixe plus spécifique.
 */
const LEADING_PHRASES = [
  "je voudrais",
  "je souhaiterais",
  "je souhaite",
  "j'aimerais",
  "jaimerais",
  "je veux",
  "je dois",
  "peux-tu",
  "peux tu",
  "pourrais-tu",
  "pourrais tu",
  "pourriez-vous",
  "pourriez vous",
  "il faudrait",
  "il faut",
  "est-ce que",
  "est ce que",
  "on doit",
  "on peut",
  "on devrait",
  "fais",
  "fait",
  "ajoute",
];

/**
 * Retire une éventuelle formule d'amorce en tête de `text`. Comparaison
 * insensible à la casse et aux accents via normalisation NFD (é→e), mais
 * seulement quand elle préserve la longueur caractère à caractère (accents
 * français courants) — sinon (ligatures rares type œ) on renonce plutôt que
 * de risquer un découpage incohérent, la formule reste alors non détectée.
 */
function stripLeadingPhrase(text: string): string {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (normalized.length !== text.length) return text;
  const sorted = [...LEADING_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    if (!normalized.startsWith(phrase)) continue;
    const rest = text.slice(phrase.length);
    // Frontière de mot obligatoire : "fais" ne doit pas mordre sur "faisceau".
    if (rest.length > 0 && !/^[\s,:;!?'-]/.test(rest)) continue;
    return rest.replace(/^[\s,:;!?'-]+/, "");
  }
  return text;
}

/** Coupe `text` à ~`maxLen` caractères sur la dernière frontière de mot trouvée, sans ellipse. */
function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  // Sous 40 % de maxLen, le mot de tête est lui-même trop long pour une
  // frontière utile : on coupe brut plutôt que produire un titre riquiqui.
  const cut = lastSpace > maxLen * 0.4 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd();
}

const TITLE_MAX_LEN = 40;

/** Titre auto = début du premier message utilisateur, débarrassé d'une éventuelle formule d'amorce, coupé sur un mot entier (≤40 caractères). */
export function deriveTitleFromText(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (!oneLine) return "Nouvelle session";
  const stripped = stripLeadingPhrase(oneLine).trim();
  const base = stripped.length > 0 ? stripped : oneLine;
  const truncated = truncateAtWordBoundary(base, TITLE_MAX_LEN);
  if (!truncated) return "Nouvelle session";
  return truncated.charAt(0).toUpperCase() + truncated.slice(1);
}

/** Date relative courte (FR) pour une liste d'historique — pas de dépendance externe (Intl.RelativeTimeFormat suffirait mais ce format compact est plus lisible en liste étroite). */
export function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `il y a ${diffD} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

/** Sessions triées de la plus récemment mise à jour à la plus ancienne (affichage liste). */
export function sortByRecent<T extends SessionMeta>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Plafonne le nombre de sessions conservées (hygiène du document persisté,
 * même esprit que la borne à 200 tours par conversation) : au-delà de `max`,
 * les plus anciennes (par `updatedAt`) sont abandonnées — la session ACTIVE
 * est toujours préservée, même si elle est ancienne (ex. reprise d'une
 * vieille session juste avant une sauvegarde).
 */
export function capSessions<T extends SessionMeta>(sessions: T[], activeId: string, max: number): T[] {
  if (sessions.length <= max) return sessions;
  const kept = new Set(sortByRecent(sessions).slice(0, max).map((s) => s.id));
  kept.add(activeId);
  return sessions.filter((s) => kept.has(s.id));
}
