/*
 * Dossier personnel (`~`) de l'utilisateur — demandé au système, jamais deviné (T-107).
 *
 * ── Pourquoi ce module ───────────────────────────────────────────────────
 * `refFichier.ts` affirmait depuis T-024 « l'interface ne connaît pas le
 * dossier personnel, et l'inventer serait une devinette de plus » — vrai pour
 * la seconde moitié, faux pour la première : `homeDir()` de
 * `@tauri-apps/api/path` (présent en 2.11.1, couvert par la permission
 * `core:default` du manifeste — voir `src-tauri/capabilities/default.json`,
 * aucune capacité à ajouter) rend le dossier personnel RÉEL. Il suffisait de
 * le demander.
 *
 * ── Ce qui n'a pas changé ────────────────────────────────────────────────
 * Sans réponse du système (hors Tauri, tests, ou appel qui échoue), on ne
 * prétend toujours rien : `null`, jamais d'exception, jamais de valeur
 * inventée — le comportement reste EXACTEMENT celui d'avant ce ticket.
 *
 * ── Patron repris de survolReference.ts ─────────────────────────────────
 * Cache module-scope + `Set` d'écouteurs + `useSyncExternalStore` côté React,
 * chargement paresseux protégé par une promesse module-scope (N composants
 * montés en même temps = UN seul appel système).
 */
import { useEffect, useSyncExternalStore } from "react";
import { homeDir } from "@tauri-apps/api/path";

/** Barre finale retirée, sauf pour la racine `/` elle-même. Pure — testable sans Tauri. */
export function sansBarreFinale(chemin: string): string {
  return chemin.length > 1 && chemin.endsWith("/") ? chemin.slice(0, -1) : chemin;
}

let cache: string | null = null;
const listeners = new Set<() => void>();
let chargementEnCours: Promise<string | null> | null = null;

function notifier(): void {
  for (const cb of listeners) cb();
}

/**
 * Pose le cache et notifie les abonnés — SEULEMENT si la valeur a réellement
 * changé (identité stable indispensable à `useSyncExternalStore`, sinon rendu
 * en boucle). Partie pure du bus, exportée séparément de `dossierPersonnel`
 * pour rester testable sans Tauri (même parti pris que `appliquerSurvol`).
 */
export function appliquerDossierPersonnel(prochain: string | null): void {
  if (cache === prochain) return;
  cache = prochain;
  notifier();
}

/** Instantané synchrone du cache module-scope : `null` tant que le système n'a pas répondu. */
export function dossierPersonnelConnu(): string | null {
  return cache;
}

/**
 * Le demande au système UNE fois (cache module-scope), ne jette jamais : hors
 * Tauri (tests, navigateur) ou en cas d'échec, rend `null` sans lever.
 */
export async function dossierPersonnel(): Promise<string | null> {
  if (cache !== null) return cache;
  if (!chargementEnCours) {
    chargementEnCours = homeDir()
      .then((brut) => sansBarreFinale(brut))
      .catch(() => null);
  }
  const valeur = await chargementEnCours;
  appliquerDossierPersonnel(valeur);
  return valeur;
}

export function subscribeDossierPersonnel(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Hook React : re-rend quand le dossier personnel devient connu. */
export function useDossierPersonnel(): string | null {
  const valeur = useSyncExternalStore(subscribeDossierPersonnel, dossierPersonnelConnu, dossierPersonnelConnu);

  useEffect(() => {
    dossierPersonnel().catch(() => {
      // `dossierPersonnel` ne jette déjà pas ; ce `catch` est une ceinture de
      // sécurité pour ne jamais faire remonter de rejet non géré depuis un effet.
    });
  }, []);

  return valeur;
}
