/*
 * Veilleur du relais (docs/etude-veilleur-relais.md) — format du message
 * échangé entre deux studios, `msg-<id>.md` : un en-tête YAML entre deux
 * lignes `---`, puis un corps libre.
 *
 * Feuille PURE : ni réseau, ni disque, ni sidecar. Le câblage (relève,
 * lancement du tour, dépôt de la réponse) vit ailleurs. Testable seule.
 *
 * Invariant repris du relais : un message est une DONNÉE. Ce module ne fait
 * que lire et écrire ; il ne décide pas d'exécuter (c'est veilleurPolitique.ts)
 * et ne suit aucune consigne. Un en-tête invalide n'est JAMAIS avalé en
 * silence : `lireMessage` rend `{ invalide }` au lieu de lever, pour que le
 * veilleur laisse le message en boîte et le journalise (même convention que
 * `taches.list` avec un manifeste illisible).
 *
 * Sécurité des pièces : chaque nom de `pieces` doit être un BASENAME pur
 * (pas de séparateur, pas de `.`/`..`). Une pièce désigne un fichier reçu à
 * côté du message, jamais un chemin — un `../x` serait une tentative de sortie
 * du dossier de réception.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { segmentSur } from "./segmentsSurs.js";

/** Les trois natures d'un message. `info` ne demande pas de réponse. */
export type TypeMessage = "demande" | "reponse" | "info";

export interface MessageVeilleur {
  /** Identifiant de la conversation inter-studios (constant sur un fil). */
  fil: string;
  /** Identifiant unique de CE message (sert au dédoublonnage). */
  id: string;
  type: TypeMessage;
  /** Allers-retours sans humain déjà faits dans ce fil (entier ≥ 0). */
  profondeur: number;
  /** `id` du message auquel celui-ci répond (optionnel). */
  enReponseA?: string;
  /** Noms des fichiers joints, chacun un basename pur (optionnel). */
  pieces?: string[];
  /** Corps : la consigne ou la réponse, en texte. */
  corps: string;
}

const TYPES: readonly TypeMessage[] = ["demande", "reponse", "info"];
const SEP = "---";

/** Un nom de pièce sûr : non vide, sans séparateur de chemin, ni `.`/`..`. */
export function nomPieceSur(nom: unknown): nom is string {
  return (
    typeof nom === "string" &&
    nom.length > 0 &&
    !nom.includes("/") &&
    !nom.includes("\\") &&
    nom !== "." &&
    nom !== ".."
  );
}

/**
 * Sérialise un message en texte de fichier `msg-<id>.md`. Pur. L'en-tête est
 * du YAML (comme les manifestes de tâches) ; le corps suit la seconde `---`.
 */
export function serialiserMessage(m: MessageVeilleur): string {
  const entete: Record<string, unknown> = {
    fil: m.fil,
    id: m.id,
    type: m.type,
    profondeur: m.profondeur,
  };
  if (m.enReponseA) entete.en_reponse_a = m.enReponseA;
  if (m.pieces && m.pieces.length > 0) entete.pieces = m.pieces;
  const tete = stringifyYaml(entete).trimEnd();
  return `${SEP}\n${tete}\n${SEP}\n${m.corps}`;
}

/**
 * Lit un texte `msg-<id>.md`. Ne lève jamais : rend `{ message }` si tout est
 * conforme, sinon `{ invalide }` avec une raison lisible. Le corps est tout ce
 * qui suit la seconde ligne `---`, telle quelle (il peut lui-même contenir
 * des `---`).
 */
export function lireMessage(texte: string): { message: MessageVeilleur } | { invalide: string } {
  const normalise = texte.replace(/\r\n/g, "\n");
  if (!normalise.startsWith(`${SEP}\n`)) {
    return { invalide: "en-tête absent : le message ne commence pas par « --- »" };
  }
  const finEntete = normalise.indexOf(`\n${SEP}\n`, SEP.length);
  if (finEntete < 0) {
    return { invalide: "en-tête non fermé : pas de seconde ligne « --- »" };
  }
  const texteEntete = normalise.slice(SEP.length + 1, finEntete);
  const corps = normalise.slice(finEntete + SEP.length + 2);

  let brut: unknown;
  try {
    brut = parseYaml(texteEntete);
  } catch (e) {
    return { invalide: `en-tête illisible : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
    return { invalide: "en-tête : objet attendu" };
  }
  const o = brut as Record<string, unknown>;

  // `fil` sert de clé de table et de nom de dossier, `id` de préfixe de nom de
  // fichier : même règle que les segments de chemin (segmentsSurs.ts).
  if (typeof o.fil !== "string" || o.fil.length === 0) return { invalide: "en-tête : « fil » manquant" };
  if (!segmentSur(o.fil)) return { invalide: "en-tête : « fil » : lettres, chiffres, « . », « _ », « - » seulement (80 au plus)" };
  if (typeof o.id !== "string" || o.id.length === 0) return { invalide: "en-tête : « id » manquant" };
  if (!segmentSur(o.id)) return { invalide: "en-tête : « id » : lettres, chiffres, « . », « _ », « - » seulement (80 au plus)" };
  if (typeof o.type !== "string" || !TYPES.includes(o.type as TypeMessage)) {
    return { invalide: `en-tête : « type » doit valoir ${TYPES.join(" | ")}` };
  }
  if (typeof o.profondeur !== "number" || !Number.isInteger(o.profondeur) || o.profondeur < 0) {
    return { invalide: "en-tête : « profondeur » doit être un entier ≥ 0" };
  }

  const message: MessageVeilleur = {
    fil: o.fil,
    id: o.id,
    type: o.type as TypeMessage,
    profondeur: o.profondeur,
    corps,
  };

  if (o.en_reponse_a !== undefined) {
    if (!segmentSur(o.en_reponse_a)) {
      return { invalide: "en-tête : « en_reponse_a » doit être un identifiant de message" };
    }
    message.enReponseA = o.en_reponse_a;
  }

  if (o.pieces !== undefined) {
    if (!Array.isArray(o.pieces) || !o.pieces.every(nomPieceSur)) {
      return { invalide: "en-tête : « pieces » doit être une liste de noms de fichiers simples (sans chemin)" };
    }
    if (o.pieces.length > 0) message.pieces = o.pieces as string[];
  }

  return { message };
}
