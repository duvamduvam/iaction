/*
 * T-148 — logique PURE du menu des périphériques audio du composeur : quelles
 * entrées afficher pour le micro, et comment lire la réponse de la coquille
 * pour les sorties. Aucun accès au DOM ni à Tauri ici (testable à sec).
 */
import type { MicrophoneDevice } from "./audioCapture";

/** Une ligne de la section « Micro ». `valeur` `""` = défaut du système. */
export interface EntreeMicro {
  valeur: string;
  libelle: string;
  /** Mémorisé mais absent de la liste (casque déconnecté) : montré, jamais remplacé en silence. */
  indisponible: boolean;
}

export const LIBELLE_MICRO_DEFAUT = "Défaut système";

/**
 * Entrées de la section « Micro » : le défaut système, les micros énumérés, puis
 * — si le choix mémorisé n'y figure plus — une entrée « (indisponible) ».
 *
 * POURQUOI garder cette entrée : un casque débranché ne doit pas faire retomber
 * la dictée sur le micro interne sans que rien ne le dise. L'utilisateur voit
 * son choix, voit qu'il est absent, et décide.
 *
 * Les `deviceId` vides sont écartés : avant la première autorisation du micro,
 * WebKit énumère des périphériques sans identifiant, inutilisables comme valeur
 * (même filtre que l'onglet Voix de la configuration).
 */
export function construireEntreesMicro(micros: readonly MicrophoneDevice[], courant: string): EntreeMicro[] {
  const entrees: EntreeMicro[] = [{ valeur: "", libelle: LIBELLE_MICRO_DEFAUT, indisponible: false }];
  const vus = new Set<string>([""]);
  for (const micro of micros) {
    if (micro.deviceId === "" || vus.has(micro.deviceId)) continue;
    vus.add(micro.deviceId);
    entrees.push({ valeur: micro.deviceId, libelle: micro.label, indisponible: false });
  }
  if (!vus.has(courant)) {
    entrees.push({ valeur: courant, libelle: "Micro mémorisé (indisponible)", indisponible: true });
  }
  return entrees;
}

/**
 * Un périphérique audio du SYSTÈME (sortie ou entrée), tel que rendu par les commandes
 * `audio_sorties_lister` / `audio_entrees_lister`. `coupe` : `mute` du serveur audio — la panne
 * d'origine de T-148 était un micro interne par défaut ET coupé.
 */
export interface PeripheriqueAudio {
  nom: string;
  libelle: string;
  parDefaut: boolean;
  coupe: boolean;
}

export interface ListePeripheriques {
  /** Faux hors Linux : sorties masquées, micro retombé sur les entrées web. */
  prisEnCharge: boolean;
  peripheriques: PeripheriqueAudio[];
}

/** Libellé affiché : l'état coupé se voit sans ouvrir le mélangeur du système. */
export function libelleAvecEtat(p: PeripheriqueAudio): string {
  return p.coupe ? `${p.libelle} (coupé)` : p.libelle;
}

/**
 * Valide la réponse brute de la coquille. LÈVE sur une forme inattendue plutôt
 * que de répondre « aucun périphérique » : une coquille et une UI désaccordées
 * doivent se voir (message dans le menu + journal), pas se déguiser en liste vide.
 */
export function lireListePeripheriques(brut: unknown): ListePeripheriques {
  if (typeof brut !== "object" || brut === null) throw new Error("réponse des périphériques audio inattendue");
  const { prisEnCharge, peripheriques } = brut as Record<string, unknown>;
  if (typeof prisEnCharge !== "boolean" || !Array.isArray(peripheriques)) {
    throw new Error("réponse des périphériques audio inattendue");
  }
  const lus: PeripheriqueAudio[] = [];
  for (const brutP of peripheriques) {
    const e = (typeof brutP === "object" && brutP !== null ? brutP : {}) as Record<string, unknown>;
    if (
      typeof e.nom !== "string" ||
      typeof e.libelle !== "string" ||
      typeof e.parDefaut !== "boolean" ||
      typeof e.coupe !== "boolean"
    ) {
      throw new Error("un périphérique audio de la réponse est mal formé");
    }
    lus.push({ nom: e.nom, libelle: e.libelle, parDefaut: e.parDefaut, coupe: e.coupe });
  }
  return { prisEnCharge, peripheriques: lus };
}
