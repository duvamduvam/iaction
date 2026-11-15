/*
 * Titres et recherche des discussions (docs/spec-titres-discussions.md, T-197).
 *
 * Tout ce qui DÉCIDE est ici, pur et testé hors fenêtre :
 *  - quand demander un titre (`doitTitrer`) et sur quel texte (`premierEchange`) ;
 *  - comment un titre arrivé tardivement atterrit sur la bonne session
 *    (`poserTitreIA`) sans écraser un renommage fait entre-temps ;
 *  - la recherche (`filtrerSessions`) ;
 *  - le passage de rattrapage (`rattraperTitres`).
 * Les pages ne font que brancher leur état et leurs écritures.
 */

import type { SessionMeta } from "./sessionStore";

/* ───────────────────────── Décision de déclenchement ───────────────────────── */

/** Message vu par l'utilisateur et réponse terminée, tels que la page les lit dans ses tours. */
export interface Echange {
  message: string;
  reponse: string;
}

/** Une ligne d'historique réduite à ce dont le titre a besoin (le même modèle pour Projets et Chat). */
export interface LigneTitrable {
  role: "user" | "assistant";
  texte: string;
  /** La ligne est close (`done`) : une réponse en cours ou interrompue ne titre pas. */
  terminee: boolean;
}

/**
 * Premier message utilisateur non vide et première réponse TERMINÉE qui le
 * suit, ou `null`. Le texte du message est celui que l'utilisateur a vu
 * (`displayContent ?? content` côté appelant), jamais le bloc de connaissances.
 */
export function premierEchange(lignes: readonly LigneTitrable[]): Echange | null {
  const rangMessage = lignes.findIndex((l) => l.role === "user" && l.texte.trim().length > 0);
  if (rangMessage < 0) return null;
  const reponse = lignes.slice(rangMessage + 1).find((l) => l.role === "assistant" && l.terminee && l.texte.trim().length > 0);
  if (!reponse) return null;
  return { message: lignes[rangMessage].texte, reponse: reponse.texte };
}

export interface CandidatTitre {
  id: string;
  titleCustom: boolean;
  titreIA?: string;
  /** Moteur Claude (abonnement) : un moteur neutre, en particulier local, a pu être choisi pour que le texte ne parte pas chez Anthropic. */
  moteurClaude: boolean;
  echange: Echange | null;
}

/** Une tentative par session et par lancement : l'ensemble vit en mémoire, il est vidé au rechargement. */
const tentees = new Set<string>();

export function dejaTentee(id: string, ensemble: ReadonlySet<string> = tentees): boolean {
  return ensemble.has(id);
}

export function marquerTentee(id: string, ensemble: Set<string> = tentees): void {
  ensemble.add(id);
}

/** Pour les tests : repartir d'un lancement neuf. */
export function oublierTentatives(): void {
  tentees.clear();
}

/**
 * Faut-il demander un titre à cette session ? Non si elle est renommée ou déjà
 * titrée, si elle ne tourne pas sur le moteur Claude, s'il manque le premier
 * message ou sa réponse terminée, ou si elle a déjà été tentée ce lancement.
 * L'ensemble des tentatives est aussi ce qui évite toute boucle quand le
 * sidecar en service ne connaît pas encore la méthode.
 */
export function doitTitrer(c: CandidatTitre, ensemble: ReadonlySet<string> = tentees): boolean {
  if (c.titleCustom) return false;
  if (typeof c.titreIA === "string" && c.titreIA.trim().length > 0) return false;
  if (!c.moteurClaude) return false;
  if (!c.echange) return false;
  return !ensemble.has(c.id);
}

/* ───────────────────────── Arrivée du titre ───────────────────────── */

/**
 * Pose `titre` sur la session `id`, ou ne change rien. La réponse arrive
 * parfois longtemps après l'envoi : l'utilisateur a pu renommer la session
 * (le renommage gagne), la supprimer, ou la faire titrer autrement. Renvoie la
 * MÊME référence de tableau quand rien ne change (pas de rendu ni de
 * sauvegarde inutiles).
 */
export function poserTitreIA<T extends SessionMeta>(sessions: readonly T[], id: string, titre: string): T[] {
  const propre = titre.trim();
  if (propre.length === 0) return sessions as T[];
  let change = false;
  const suivant = sessions.map((s) => {
    if (s.id !== id || s.titleCustom || (typeof s.titreIA === "string" && s.titreIA.length > 0)) return s;
    change = true;
    return { ...s, titreIA: propre, title: propre };
  });
  return change ? suivant : (sessions as T[]);
}

/** Lecture tolérante du `done` de `claude.titreDiscussion` : une chaîne non vide, sinon `null`. */
export function parseTitreDiscussion(data: Record<string, unknown>): string | null {
  return typeof data.titre === "string" && data.titre.trim().length > 0 ? data.titre.trim() : null;
}

/* ───────────────────────── Recherche ───────────────────────── */

/** Minuscules, sans accents, espaces normalisés : « Ukulélé » et « ukulele » se valent. */
export function normaliserRecherche(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sessions dont le titre affiché, puis le texte (`contenu`, facultatif), portent
 * TOUS les mots saisis. Requête vide : tout est rendu, dans l'ordre reçu. Le
 * contenu n'est calculé que si le titre seul ne suffit pas (il est coûteux :
 * tous les tours). Archives : appelées sans `contenu`, leur texte n'est pas en
 * mémoire.
 */
export function filtrerSessions<T extends { title: string }>(
  sessions: readonly T[],
  requete: string,
  contenu?: (s: T) => string,
): T[] {
  const mots = normaliserRecherche(requete).split(" ").filter((m) => m.length > 0);
  if (mots.length === 0) return [...sessions];
  return sessions.filter((s) => {
    const titre = normaliserRecherche(s.title);
    if (mots.every((m) => titre.includes(m))) return true;
    if (!contenu) return false;
    const tout = `${titre}\n${normaliserRecherche(contenu(s))}`;
    return mots.every((m) => tout.includes(m));
  });
}

/* ───────────────────────── Rattrapage de l'existant ───────────────────────── */

/** Trois échecs d'affilée : le quota est probablement atteint, on s'arrête plutôt que de continuer à frapper. */
export const ECHECS_CONSECUTIFS_MAX = 3;

export interface BilanRattrapage {
  nommees: number;
  echecs: number;
  /** Sessions découvertes inéligibles au moment du traitement (archives surtout) : ni nommées ni en échec. */
  ignorees: number;
  /** Arrêt voulu par l'utilisateur. */
  arrete: boolean;
  /** Arrêt automatique après `ECHECS_CONSECUTIFS_MAX` échecs d'affilée. */
  quota: boolean;
}

/**
 * Passage unique sur `ids`, UNE session à la fois. `nommer` rend le titre ou
 * `null` (échec : on passe à la suivante) ; `appliquer` écrit le titre là où la
 * session vit (vive ou archive). Le bouton d'arrêt agit entre deux sessions.
 */
export async function rattraperTitres(args: {
  ids: readonly string[];
  /** Titre ; `null` = échec (compte pour l'arrêt quota) ; `undefined` = session finalement inéligible, ni succès ni échec. */
  nommer: (id: string) => Promise<string | null | undefined>;
  appliquer: (id: string, titre: string) => Promise<void> | void;
  arret: { readonly arrete: boolean };
  progression?: (fait: number, total: number) => void;
}): Promise<BilanRattrapage> {
  const { ids, nommer, appliquer, arret, progression } = args;
  const bilan: BilanRattrapage = { nommees: 0, echecs: 0, ignorees: 0, arrete: false, quota: false };
  let consecutifs = 0;
  for (let i = 0; i < ids.length; i++) {
    if (arret.arrete) {
      bilan.arrete = true;
      break;
    }
    progression?.(i, ids.length);
    let titre: string | null | undefined = null;
    try {
      titre = await nommer(ids[i]);
    } catch {
      titre = null;
    }
    if (titre === undefined) {
      bilan.ignorees++;
    } else if (titre) {
      consecutifs = 0;
      await appliquer(ids[i], titre);
      bilan.nommees++;
    } else {
      bilan.echecs++;
      consecutifs++;
      if (consecutifs >= ECHECS_CONSECUTIFS_MAX) {
        bilan.quota = true;
        break;
      }
    }
  }
  progression?.(bilan.nommees + bilan.echecs + bilan.ignorees, ids.length);
  return bilan;
}
