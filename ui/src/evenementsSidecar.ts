/*
 * Événements NON SOLLICITÉS du sidecar : ceux qui arrivent sans `id` sur le
 * canal `sidecar:event` (docs/protocol.md) — `ready` au démarrage, `veilleur`
 * à chaque changement d'état du veilleur du relais (T-227).
 *
 * Sorti de sidecar.ts (au plafond du cliquet de taille) : la corrélation par
 * `id` reste là-bas, la diffusion par nom d'événement vit ici. Abonnements
 * synchrones dans un Set, sûrs avec le double montage des effets en
 * StrictMode. Un abonné qui lève ne prive pas les autres.
 */
import type { ReadyInfo } from "./sidecar";

type Abonne = (data: Record<string, unknown>) => void;

const abonnes = new Map<string, Set<Abonne>>();

/** Diffuse un événement sans `id` à ses abonnés (appelé par sidecar.ts). */
export function diffuserSansId(evenement: string, data: Record<string, unknown> | undefined): void {
  for (const cb of [...(abonnes.get(evenement) ?? [])]) {
    try {
      cb(data ?? {});
    } catch (e) {
      // Pas de journal ici (le journal passe par le sidecar) : la console suffit à ne pas l'avaler.
      console.error(`abonné à l'événement « ${evenement} » en échec`, e);
    }
  }
}

/** S'abonne à un événement non sollicité ; renvoie le désabonnement. */
export function ecouterEvenement(evenement: string, cb: Abonne): () => void {
  let set = abonnes.get(evenement);
  if (!set) {
    set = new Set();
    abonnes.set(evenement, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export function subscribeReady(cb: (info: ReadyInfo) => void): () => void {
  return ecouterEvenement("ready", (data) => cb(data as unknown as ReadyInfo));
}
