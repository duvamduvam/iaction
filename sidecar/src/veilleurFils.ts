/*
 * Veilleur du relais — mémoire des FILS d'un poste,
 * `<config>/net.duvam.iaction/veilleur/fils.json` (hors projet : un agent ne
 * l'écrit jamais).
 *
 * Côté qui EXÉCUTE (le veilleur) :
 * - la session Claude de chaque fil (un fil = une session) ;
 * - le coût cumulé connu de cette session : le moteur rend le total du
 *   transcript repris, le coût d'UN message est l'écart avec le précédent.
 * Côté qui DEMANDE (`relais_demander`) :
 * - la plus grande profondeur connue du fil (borne du dialogue autonome) ;
 * - le studio à qui le fil a été adressé : seul lui peut y répondre.
 *
 * Table SANS prototype (`Object.create(null)`) : un fil `__proto__` (refusé
 * de toute façon par la lecture des messages) ne peut rien polluer. Purge à
 * 8 jours. Écriture atomique ; le cache n'est remplacé qu'après l'écriture.
 * Seul un fichier ABSENT donne une mémoire neuve : illisible, elle lève.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import { globalConfigRoot } from "./appPaths.js";

const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

interface EntreeFil {
  sessionId?: string;
  coutCumule?: number;
  profondeur?: number;
  destinataire?: string;
  /** Dernière mise à jour (ms). */
  le: number;
}

type Table = Record<string, EntreeFil>;

export interface MemoireFils {
  sessionDe(fil: string): Promise<string | null>;
  memoriserSession(fil: string, sessionId: string): Promise<void>;
  oublierSession(fil: string): Promise<void>;
  /** Coût cumulé connu de la session du fil (total du moteur au dernier tour). */
  coutCumuleDe(fil: string): Promise<number | null>;
  memoriserCoutCumule(fil: string, total: number): Promise<void>;
  profondeurDe(fil: string): Promise<number | null>;
  memoriserProfondeur(fil: string, profondeur: number): Promise<void>;
  destinataireDe(fil: string): Promise<string | null>;
  memoriserDestinataire(fil: string, destinataire: string): Promise<void>;
}

export function cheminFilsDefaut(): string {
  return path.join(globalConfigRoot(), "veilleur", "fils.json");
}

function tableVide(): Table {
  return Object.create(null) as Table;
}

export function creerMemoireFils(chemin: string = cheminFilsDefaut(), maintenant: () => number = Date.now): MemoireFils {
  let cache: Table | null = null;

  async function charger(): Promise<Table> {
    if (cache) return cache;
    let texte: string;
    try {
      texte = await fsp.readFile(chemin, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        cache = tableVide();
        return cache;
      }
      throw new Error(`mémoire des fils illisible (${path.basename(chemin)}) : ${(e as Error).message}`);
    }
    let brut: unknown;
    try {
      brut = JSON.parse(texte);
    } catch (e) {
      throw new Error(`mémoire des fils corrompue (${path.basename(chemin)}) : ${(e as Error).message}`);
    }
    const t = tableVide();
    if (typeof brut === "object" && brut !== null && !Array.isArray(brut)) {
      for (const [fil, v] of Object.entries(brut as Record<string, unknown>)) {
        if (typeof v !== "object" || v === null) continue;
        const o = v as Record<string, unknown>;
        if (typeof o.le !== "number") continue;
        t[fil] = {
          le: o.le,
          ...(typeof o.sessionId === "string" && o.sessionId ? { sessionId: o.sessionId } : {}),
          ...(typeof o.coutCumule === "number" && Number.isFinite(o.coutCumule) ? { coutCumule: o.coutCumule } : {}),
          ...(typeof o.profondeur === "number" && Number.isInteger(o.profondeur) && o.profondeur >= 0 ? { profondeur: o.profondeur } : {}),
          ...(typeof o.destinataire === "string" && o.destinataire ? { destinataire: o.destinataire } : {}),
        };
      }
    }
    cache = t;
    return cache;
  }

  function vivants(t: Table): Table {
    const limite = maintenant() - RETENTION_MS;
    const copie = tableVide();
    for (const fil of Object.keys(t)) if (t[fil].le >= limite) copie[fil] = { ...t[fil] };
    return copie;
  }

  async function lire(fil: string): Promise<EntreeFil | null> {
    const t = vivants(await charger());
    return Object.hasOwn(t, fil) ? t[fil] : null;
  }

  async function modifier(fil: string, f: (e: EntreeFil) => void): Promise<void> {
    const t = vivants(await charger());
    const e: EntreeFil = Object.hasOwn(t, fil) ? t[fil] : { le: maintenant() };
    f(e);
    e.le = maintenant();
    t[fil] = e;
    await fsp.mkdir(path.dirname(chemin), { recursive: true });
    const tmp = `${chemin}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(t), "utf8");
    await fsp.rename(tmp, chemin);
    cache = t;
  }

  return {
    async sessionDe(fil) {
      return (await lire(fil))?.sessionId ?? null;
    },
    async memoriserSession(fil, sessionId) {
      await modifier(fil, (e) => {
        if (e.sessionId !== sessionId) delete e.coutCumule; // session neuve : cumul neuf
        e.sessionId = sessionId;
      });
    },
    async oublierSession(fil) {
      if ((await lire(fil))?.sessionId === undefined) return;
      await modifier(fil, (e) => {
        delete e.sessionId;
        delete e.coutCumule;
      });
    },
    async coutCumuleDe(fil) {
      return (await lire(fil))?.coutCumule ?? null;
    },
    async memoriserCoutCumule(fil, total) {
      await modifier(fil, (e) => {
        e.coutCumule = total;
      });
    },
    async profondeurDe(fil) {
      return (await lire(fil))?.profondeur ?? null;
    },
    async memoriserProfondeur(fil, profondeur) {
      await modifier(fil, (e) => {
        e.profondeur = Math.max(e.profondeur ?? 0, profondeur);
      });
    },
    async destinataireDe(fil) {
      return (await lire(fil))?.destinataire ?? null;
    },
    async memoriserDestinataire(fil, destinataire) {
      await modifier(fil, (e) => {
        e.destinataire = destinataire;
      });
    },
  };
}
