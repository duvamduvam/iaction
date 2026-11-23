/*
 * Veilleur du relais — client réel des boîtes aux lettres du broker, pour le
 * sidecar principal (le `ClientBoite` injecté dans veilleurCycle.ts). Il parle
 * aux mêmes routes `/boites` que le connecteur MCP « Relais entre studios »,
 * mais garde le contenu EN MÉMOIRE (le cycle lit le texte du message), au lieu
 * d'écrire dans `relais-recu/`.
 *
 * La fonction de requête est injectable : les tests passent un faux au lieu
 * d'ouvrir une socket. Un statut non-2xx lève une erreur lisible (le cycle la
 * rattrape et la journalise ; une relève ne tombe jamais pour un message).
 */

import { requeteRelais, corpsMultipart, type ReponseRelais } from "./relaisHttp.js";
import type { ClientBoite, FichierBoite } from "./veilleurCycle.js";

export interface ConfigBoite {
  /** Adresse du broker (https://…, résolue depuis la config du veilleur). */
  url: URL;
  /** Jeton du studio local — vient du coffre, jamais écrit en clair. */
  jeton: string;
  /** Autorité de certification supplémentaire (PEM), optionnelle. */
  ca?: string;
  /** Environnement, pour le proxy (injectable en test). */
  env?: NodeJS.ProcessEnv;
}

type Requete = typeof requeteRelais;

function joindre(base: URL, chemin: string): URL {
  const u = new URL(base.toString());
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${chemin}`;
  return u;
}

function verifier(r: ReponseRelais, quoi: string): ReponseRelais {
  if (r.statut < 200 || r.statut >= 300) {
    const extrait = r.corps.toString("utf8").slice(0, 200);
    throw new Error(`${quoi} : le relais répond ${r.statut} ${extrait}`);
  }
  return r;
}

/**
 * Crée le client de boîte. `requete` est injectable (défaut : le vrai client
 * HTTP). `segment` encode un nom pour l'URL.
 */
export function creerClientBoite(cfg: ConfigBoite, requete: Requete = requeteRelais): ClientBoite {
  const entetes = { Authorization: `Bearer ${cfg.jeton}` };
  const commun = { ca: cfg.ca, env: cfg.env };
  const segment = (nom: string) => encodeURIComponent(nom);

  async function listerRecus(): Promise<FichierBoite[]> {
    const r = verifier(await requete({ methode: "GET", url: joindre(cfg.url, "boites"), entetes, ...commun }), "liste de la boîte");
    let data: unknown;
    try {
      data = JSON.parse(r.corps.toString("utf8"));
    } catch {
      throw new Error("liste de la boîte : réponse non-JSON du relais");
    }
    const fichiers = (data as { fichiers?: unknown }).fichiers;
    if (!Array.isArray(fichiers)) return [];
    // Taille et date de dépôt : le cycle les compare après lecture (le broker
    // écrase un fichier de même nom et en réécrit l'émetteur).
    return fichiers
      .filter((f): f is { nom: string; de?: unknown; taille?: unknown; depose_le?: unknown } => typeof f === "object" && f !== null && typeof (f as { nom?: unknown }).nom === "string")
      .map((f) => ({
        nom: f.nom,
        de: typeof f.de === "string" ? f.de : "?",
        ...(typeof f.taille === "number" ? { taille: f.taille } : {}),
        ...(typeof f.depose_le === "number" || typeof f.depose_le === "string" ? { deposeLe: f.depose_le } : {}),
      }));
  }

  async function telechargerBrut(nom: string): Promise<Buffer> {
    const r = verifier(
      await requete({ methode: "GET", url: joindre(cfg.url, `boites/${segment(nom)}`), entetes, ...commun }),
      `téléchargement de ${nom}`,
    );
    return r.corps;
  }

  async function deposerBrut(dest: string, nom: string, contenu: Buffer): Promise<void> {
    const mp = corpsMultipart(nom, contenu);
    verifier(
      await requete({
        methode: "POST",
        url: joindre(cfg.url, `boites/${segment(dest.trim().toLowerCase())}`),
        entetes: { ...entetes, "Content-Type": mp.type },
        corps: mp.corps,
        ...commun,
      }),
      `dépôt chez ${dest}`,
    );
  }

  return {
    listerRecus,

    async telecharger(nom: string): Promise<string> {
      return (await telechargerBrut(nom)).toString("utf8");
    },

    telechargerBrut,

    async deposer(dest: string, nom: string, contenu: string): Promise<void> {
      await deposerBrut(dest, nom, Buffer.from(contenu, "utf8"));
    },

    deposerBrut,

    async supprimer(nom: string): Promise<void> {
      verifier(
        await requete({ methode: "DELETE", url: joindre(cfg.url, `boites/${segment(nom)}`), entetes, ...commun }),
        `suppression de ${nom}`,
      );
    },
  };
}
