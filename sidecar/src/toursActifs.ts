/**
 * Tours en cours — compteur tenu au point central d'émission (index.ts).
 *
 * Sert la fermeture automatique du coffre (docs/etude-coffre-secrets.md
 * § 4.3) : à la veille ou au verrouillage de session, la coquille demande
 * `coffre.attendreFin` et le coffre ne se ferme qu'une fois le dernier tour
 * terminé.
 *
 * Un tour = une requête de méthode « longue » (`TOURS`), ouverte à sa
 * réception, fermée à son `done` ou `error`. Compter à ce niveau plutôt que
 * dans chaque moteur garde une seule vérité, indépendante de la manière dont
 * chaque handler attend (ou non) la fin de son flux.
 */

import type { EngineEmitter } from "./engine.js";

/** Méthodes dont une requête vit le temps d'un tour (streamées). */
export const TOURS: ReadonlySet<string> = new Set(["claude.start", "neutral.start", "orch.run", "chat.send"]);

const ouverts = new Set<string>();
const abonnes = new Set<(nombre: number) => void>();

function prevenir(): void {
  for (const f of [...abonnes]) f(ouverts.size);
}

/** Requête reçue : compte un tour si la méthode en est un. */
export function ouvrirSiTour(id: string, method: string): void {
  if (!TOURS.has(method) || ouverts.has(id)) return;
  ouverts.add(id);
  prevenir();
}

/** `done` ou `error` émis pour `id` : le tour, s'il en était un, est fini. */
export function fermer(id: string): void {
  if (ouverts.delete(id)) prevenir();
}

export function nombreDeTours(): number {
  return ouverts.size;
}

/** S'abonne aux changements du nombre de tours ; renvoie le désabonnement. */
export function surChangement(f: (nombre: number) => void): () => void {
  abonnes.add(f);
  return () => abonnes.delete(f);
}

/**
 * `coffre.attendreFin` (réservée à la coquille) — un chunk `{tours}` à chaque
 * changement tant qu'il reste des tours, puis `done` quand il n'y en a plus.
 * Sans tour en cours : `done` immédiat.
 */
export function handleCoffreAttendreFin(id: string, emitter: EngineEmitter): void {
  if (ouverts.size === 0) {
    emitter.done(id, { tours: 0 });
    return;
  }
  emitter.chunk(id, { tours: ouverts.size });
  const desabonner = surChangement((nombre) => {
    if (nombre === 0) {
      desabonner();
      emitter.done(id, { tours: 0 });
    } else {
      emitter.chunk(id, { tours: nombre });
    }
  });
}

/** Tests seulement. */
export function _reinitialiser(): void {
  ouverts.clear();
  abonnes.clear();
}
