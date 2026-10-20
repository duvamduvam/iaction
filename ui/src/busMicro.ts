/*
 * T-148 — pont minuscule entre le menu des périphériques audio du composeur et
 * `useSpeech`, propriétaire unique de la config voix.
 *
 * POURQUOI un bus et pas une prop : `VoiceButtons` est monté par ChatPage ET
 * AgentPage, deux fichiers au plafond du cliquet de taille. Faire descendre un
 * callback par App → page → composeur aurait coûté des lignes dans les deux.
 * Le menu ne reçoit donc rien et passe par ce module, que `useSpeech` alimente
 * (micro courant) et écoute (demandes de patch).
 *
 * POURQUOI le menu n'écrit pas la config lui-même : `App.tsx` passe aux pages
 * `speechAdmin.config.stt.inputDeviceId`. Écrire le fichier dans son coin
 * laisserait cette prop périmée — la dictée suivante partirait sur l'ancien
 * micro, exactement le défaut qu'on corrige. Le patch passe donc par le
 * `saveConfig` de `useSpeech`, qui écrit, met l'état à jour et re-pousse au
 * sidecar.
 *
 * État de MODULE, donc propre à chaque fenêtre (une webview = un module) : les
 * fenêtres secondaires ont leur propre `useSpeech`, leur propre bus.
 */
import type { SpeechConfigPatch } from "./speechAdmin";

/* ---------- Micro courant (useSpeech → menu) ---------- */

let microCourant = "";
const abonnesMicro = new Set<() => void>();

/** Publié par `useSpeech` à chaque changement de `config.stt.inputDeviceId`. */
export function publierMicroCourant(deviceId: string): void {
  if (deviceId === microCourant) return;
  microCourant = deviceId;
  for (const rappel of [...abonnesMicro]) rappel();
}

/** Lecture pour `useSyncExternalStore` : `""` = défaut du système. */
export function lireMicroCourant(): string {
  return microCourant;
}

/** Abonnement pour `useSyncExternalStore` ; renvoie la fonction de désabonnement. */
export function abonnerMicroCourant(rappel: () => void): () => void {
  abonnesMicro.add(rappel);
  return () => {
    abonnesMicro.delete(rappel);
  };
}

/* ---------- Demandes de patch (menu → useSpeech) ---------- */

type TraitantPatch = (patch: SpeechConfigPatch) => Promise<void>;

let traitant: TraitantPatch | null = null;

/**
 * Déclaré par `useSpeech` au montage. Un seul traitant : le dernier enregistré
 * gagne, et l'ancien ne peut pas désinscrire le nouveau (StrictMode remonte
 * l'effet : désinscription puis réinscription, jamais l'inverse).
 */
export function enregistrerTraitantConfigVoix(nouveau: TraitantPatch): () => void {
  traitant = nouveau;
  return () => {
    if (traitant === nouveau) traitant = null;
  };
}

/**
 * Demande l'enregistrement d'un patch de config voix. La promesse REJETTE si
 * personne ne traite (hook pas encore monté) ou si la sauvegarde échoue : c'est
 * à l'appelant d'afficher ET de journaliser, jamais d'avaler.
 */
export function demanderPatchConfigVoix(patch: SpeechConfigPatch): Promise<void> {
  if (!traitant) return Promise.reject(new Error("la configuration de la voix n'est pas encore chargée"));
  return traitant(patch);
}
