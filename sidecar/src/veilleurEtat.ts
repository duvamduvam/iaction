/*
 * Veilleur du relais — état persistant d'un poste (l'`EtatVeilleur` injecté
 * dans veilleurCycle.ts) : un fichier JSON, `etat.json`, hors projet.
 *
 * - **messages traités**, par `id`, avec leur statut :
 *   - `en-cours` : marqué AVANT tout effet de bord (jamais rejoué) ; tant que
 *     la réponse n'est pas déposée, son texte est gardé ici (`reponse`), pour
 *     être redéposé à la relève suivante ; sans texte, le tour a été
 *     interrompu (sidecar tué) : la relève suivante le dit à l'émetteur ;
 *   - `repondu` : réponse déposée.
 *   Purgés au-delà de 8 jours (les messages expirent à 7 jours au broker).
 * - **quota de tours** : rattaché à un jour (UTC).
 * - **suspension** : coût dépassé ; persistante, levée par un humain.
 *
 * Écriture atomique ; le cache mémoire n'est remplacé qu'APRÈS l'écriture
 * réussie (un échec disque ne laisse pas une mémoire qui ment). Seul un
 * fichier ABSENT donne un état neuf : illisible ou corrompu, la lecture lève
 * — le service passe alors en `invalide`, plutôt que d'oublier les ids
 * traités et de rejouer des actions.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import type { EntreeEnCours, EtatVeilleur, ReponseEnAttente } from "./veilleurCycle.js";

const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

interface TraiteEntree {
  id: string;
  le: number;
  statut: "en-cours" | "repondu";
  nom?: string;
  de?: string;
  fil?: string;
  profondeur?: number;
  reponse?: ReponseEnAttente;
}

interface Suspension {
  motif: string;
  /** Date ISO de la suspension. */
  le: string;
}

interface EtatDisque {
  jour: string;
  tours: number;
  traites: TraiteEntree[];
  suspension: Suspension | null;
}

function jourDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function vide(): EtatDisque {
  return { jour: "", tours: 0, traites: [], suspension: null };
}

function lireSuspension(v: unknown): Suspension | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.motif === "string" && typeof o.le === "string" ? { motif: o.motif, le: o.le } : null;
}

function lireReponse(v: unknown): ReponseEnAttente | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return typeof o.dest === "string" && typeof o.nom === "string" && typeof o.contenu === "string" ? { dest: o.dest, nom: o.nom, contenu: o.contenu } : undefined;
}

function lireEntree(v: unknown): TraiteEntree | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.le !== "number") return null;
  const reponse = lireReponse(o.reponse);
  return {
    id: o.id,
    le: o.le,
    // Ancien format (sans statut) : l'id était marqué avant l'effet de bord, sans suite connue.
    statut: o.statut === "repondu" ? "repondu" : o.statut === "en-cours" ? "en-cours" : "repondu",
    ...(typeof o.nom === "string" ? { nom: o.nom } : {}),
    ...(typeof o.de === "string" ? { de: o.de } : {}),
    ...(typeof o.fil === "string" ? { fil: o.fil } : {}),
    ...(typeof o.profondeur === "number" ? { profondeur: o.profondeur } : {}),
    ...(reponse ? { reponse } : {}),
  };
}

/**
 * État persistant sur `chemin` (fichier JSON). `maintenant` est injectable.
 */
export function creerEtatFichier(chemin: string, maintenant: () => number = Date.now): EtatVeilleur {
  let cache: EtatDisque | null = null;

  async function charger(): Promise<EtatDisque> {
    if (cache) return cache;
    let texte: string;
    try {
      texte = await fsp.readFile(chemin, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        cache = vide();
        return cache;
      }
      throw new Error(`état du veilleur illisible (${path.basename(chemin)}) : ${(e as Error).message}`);
    }
    let brut: Partial<EtatDisque> & { traites?: unknown };
    try {
      brut = JSON.parse(texte) as typeof brut;
    } catch (e) {
      throw new Error(`état du veilleur corrompu (${path.basename(chemin)}) : ${(e as Error).message}`);
    }
    cache = {
      jour: typeof brut.jour === "string" ? brut.jour : "",
      tours: typeof brut.tours === "number" && brut.tours >= 0 ? brut.tours : 0,
      traites: Array.isArray(brut.traites) ? brut.traites.map(lireEntree).filter((t): t is TraiteEntree => t !== null) : [],
      suspension: lireSuspension(brut.suspension),
    };
    return cache;
  }

  function purger(e: EtatDisque): void {
    const limite = maintenant() - RETENTION_MS;
    e.traites = e.traites.filter((t) => t.le >= limite);
  }

  /** Mutation sur une COPIE, écrite, puis seulement adoptée comme cache. */
  async function muter(f: (e: EtatDisque) => void): Promise<void> {
    const copie = structuredClone(await charger());
    purger(copie);
    f(copie);
    await fsp.mkdir(path.dirname(chemin), { recursive: true });
    const tmp = `${chemin}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(copie), "utf8");
    await fsp.rename(tmp, chemin);
    cache = copie;
  }

  async function lus(): Promise<TraiteEntree[]> {
    const e = await charger();
    const limite = maintenant() - RETENTION_MS;
    return e.traites.filter((t) => t.le >= limite);
  }

  return {
    async idsTraites() {
      return (await lus()).map((t) => t.id);
    },

    async statutDe(id) {
      return (await lus()).find((t) => t.id === id)?.statut ?? null;
    },

    async marquerEnCours(m) {
      await muter((e) => {
        if (e.traites.some((t) => t.id === m.id)) return;
        e.traites.push({ id: m.id, le: maintenant(), statut: "en-cours", nom: m.nom, de: m.de, fil: m.fil, profondeur: m.profondeur });
      });
    },

    async preparerReponse(id, r) {
      await muter((e) => {
        const t = e.traites.find((x) => x.id === id);
        if (t && t.statut === "en-cours") t.reponse = { ...r };
      });
    },

    async marquerRepondu(id) {
      await muter((e) => {
        const t = e.traites.find((x) => x.id === id);
        if (!t) return;
        t.statut = "repondu";
        delete t.reponse;
      });
    },

    async enCours(): Promise<EntreeEnCours[]> {
      return (await lus())
        .filter((t) => t.statut === "en-cours" && t.nom !== undefined && t.de !== undefined && t.fil !== undefined && t.profondeur !== undefined)
        .map((t) => ({ id: t.id, nom: t.nom!, de: t.de!, fil: t.fil!, profondeur: t.profondeur!, ...(t.reponse ? { reponse: { ...t.reponse } } : {}) }));
    },

    async toursAujourdhui(): Promise<number> {
      const e = await charger();
      return e.jour === jourDe(maintenant()) ? e.tours : 0;
    },

    async incrementerTour(): Promise<void> {
      await muter((e) => {
        const jour = jourDe(maintenant());
        if (e.jour === jour) {
          e.tours += 1;
        } else {
          e.jour = jour;
          e.tours = 1;
        }
      });
    },

    async suspension(): Promise<Suspension | null> {
      const e = await charger();
      return e.suspension ? { ...e.suspension } : null;
    },

    async suspendre(motif: string): Promise<void> {
      await muter((e) => {
        e.suspension = { motif, le: new Date(maintenant()).toISOString() };
      });
    },

    async lever(): Promise<void> {
      if ((await charger()).suspension === null) return;
      await muter((e) => {
        e.suspension = null;
      });
    },
  };
}
