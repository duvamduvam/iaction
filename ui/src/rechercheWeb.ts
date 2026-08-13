/**
 * R9 — libellé de l'avancement de la recherche web (docs/spec-r9-recherche-web.md §6).
 *
 * ── Pourquoi une feuille, et pas trois lignes dans ChatPage ─────────────
 * Ce texte est la SEULE chose que l'utilisateur verra quand la recherche
 * échoue. S'il ment — ou s'il se tait —, une réponse produite de mémoire
 * passera pour une réponse vérifiée : le défaut fondateur de T-010. Une
 * logique qui décide de ça se teste ; une logique enfouie dans un composant
 * de 2 700 lignes ne se teste pas (voir architecture.md §8 : les tests ne
 * suivent pas la bonne volonté, ils suivent la structure).
 *
 * Feuille volontaire : AUCUN import, pas même de type. Elle est désormais
 * propriétaire du contrat R9 côté interface (`sidecar.ts` le ré-exporte), ce
 * qui lui évite d'importer un module qui s'abonne à Tauri au chargement —
 * même leçon que `debordNotice.ts` et `providerFormCalc.ts`.
 */

export type EtatRechercheWeb = "recherche" | "ok" | "vide" | "echec";

export interface SourceWeb {
  n: number;
  titre: string;
  url: string;
}

export interface AvancementWeb {
  etat: EtatRechercheWeb;
  sources: SourceWeb[];
  message?: string;
}

export interface OptionsWebChat {
  actif: boolean;
  onWeb?: (avancement: AvancementWeb) => void;
}

const ETATS_WEB: readonly EtatRechercheWeb[] = ["recherche", "ok", "vide", "echec"];

/**
 * Lit le `chunk.web` de R9. Tolérant par construction : un chunk d'une forme
 * inconnue (sidecar plus récent, ou plus ancien) renvoie `null` et retombe
 * dans le chemin `delta` — jamais une exception dans un flux en cours.
 */
export function parseEtatWeb(brut: unknown): AvancementWeb | null {
  if (typeof brut !== "object" || brut === null) return null;
  const v = brut as Record<string, unknown>;
  const etat = ETATS_WEB.find((e) => e === v.etat);
  if (!etat) return null;
  const sources = Array.isArray(v.sources)
    ? v.sources.flatMap((s) => {
        if (typeof s !== "object" || s === null) return [];
        const o = s as Record<string, unknown>;
        return typeof o.n === "number" && typeof o.titre === "string" && typeof o.url === "string"
          ? [{ n: o.n, titre: o.titre, url: o.url }]
          : [];
      })
    : [];
  return { etat, sources, ...(typeof v.message === "string" ? { message: v.message } : {}) };
}

/**
 * Texte du bandeau. Jamais vide, et jamais rassurant à tort : les deux
 * situations d'échec le DISENT, au lieu de laisser croire à une recherche
 * réussie.
 */
export function libelleAvancementWeb(avancement: AvancementWeb): string {
  switch (avancement.etat) {
    case "recherche":
      return "Recherche web…";
    case "ok": {
      const n = avancement.sources.length;
      return n === 1 ? "Recherche web : 1 source" : `Recherche web : ${n} sources`;
    }
    case "vide":
      return "Recherche web : aucun résultat — la réponse n'est pas vérifiée.";
    case "echec":
      return avancement.message
        ? `Recherche web indisponible (${avancement.message}) — la réponse n'est pas vérifiée.`
        : "Recherche web indisponible — la réponse n'est pas vérifiée.";
  }
}
