/**
 * Le sidecar sait-il qu'il est périmé ? (T-020)
 *
 * ── La panne qui a rendu ce module nécessaire ───────────────────────────
 * Le 2026-08-10, l'interface affichait encore « Aucune donnée reçue du
 * fournisseur » — le symptôme que T-015 était censé avoir supprimé la veille.
 * Le garde-fou existait bel et bien dans les sources ; il n'existait
 * simplement PAS dans le programme en train de tourner. L'application de
 * développement exécute `build/sidecar-bundle/`, recopié en ressource Tauri,
 * et ce dossier n'est reconstruit que par `scripts/preparer-bundle.sh` —
 * jamais par `tauri dev`, dont le `beforeDevCommand` ne bâtit que l'interface.
 * Le sidecar exécuté datait donc du 7 août : trois jours de corrections
 * (T-015, T-017, T-019…) compilées, testées, commitées, et jamais exécutées.
 *
 * Le pire n'est pas la péremption, c'est son silence : les tests passaient
 * (ils compilent leur propre `dist-verif`), le journal ne disait rien, et
 * chaque correctif semblait échouer. On corrige un bug déjà corrigé, avec
 * pour seule preuve du contraire un symptôme qui persiste.
 *
 * ── Ce que ce module garantit ───────────────────────────────────────────
 * Le code compilé emporte l'EMPREINTE des sources dont il est issu
 * (`empreinte.json`, écrit par `npm run build -w sidecar`). Au démarrage, s'il
 * retrouve un arbre de sources à côté de lui — le cas en développement —, il
 * la recalcule et la compare. Trois issues, aucune muette :
 *
 *   - `a-jour`   : rien à signaler, une ligne `info` qui prouve que le
 *                  mécanisme tourne encore ;
 *   - `perime`   : ligne `error`. Le programme exécuté n'est pas celui du
 *                  dépôt, et tout diagnostic bâti dessus est faux ;
 *   - `sans-empreinte` : ligne `warn`. Compilé avant ce garde-fou, donc d'âge
 *                  inconnu — exactement le bundle du 7 août.
 *
 * Hors dépôt (application installée), il n'y a aucune source à comparer :
 * `hors-source`, une ligne `info`, et surtout aucune fausse alerte.
 *
 * ── Pourquoi une empreinte de CONTENU et pas des dates ──────────────────
 * La première idée — comparer les `mtime` — aurait laissé passer précisément
 * la panne du 10 août : le fichier exécuté portait la date de sa RECOPIE
 * (9 août 18h37), postérieure aux sources qu'il ignorait (14h19). Une date de
 * fichier dit quand on l'a touché, jamais ce qu'il contient.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as journal from "./journal.js";

/** Nom du témoin déposé à côté du code compilé, et embarqué dans le bundle. */
export const NOM_EMPREINTE = "empreinte.json";

/** Nombre de dossiers parents explorés à la recherche des sources. */
const REMONTEE_MAX = 8;

export interface Empreinte {
  /** sha256 du contenu de toutes les sources `.ts`, chemin compris. */
  empreinte: string;
  /** Nombre de fichiers pris en compte — un module oublié se voit ici. */
  fichiers: number;
}

/**
 * Empreinte d'un arbre de sources TypeScript.
 *
 * Le chemin RELATIF entre dans le hachage autant que le contenu : un module
 * renommé, supprimé ou ajouté change l'empreinte même à contenu constant —
 * c'est ce cas-là qui s'est produit (`claudeFinDeTour.ts` absent du bundle).
 * Parcours trié, donc reproductible d'une machine à l'autre.
 */
export function calculerEmpreinte(dossierSrc: string): Empreinte {
  const hash = createHash("sha256");
  let fichiers = 0;

  const parcourir = (dossier: string, prefixe: string): void => {
    const entrees = readdirSync(dossier, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entree of entrees) {
      const relatif = prefixe ? `${prefixe}/${entree.name}` : entree.name;
      if (entree.isDirectory()) {
        parcourir(path.join(dossier, entree.name), relatif);
        continue;
      }
      if (!entree.name.endsWith(".ts")) continue;
      hash.update(relatif);
      hash.update("\0");
      hash.update(readFileSync(path.join(dossier, entree.name)));
      hash.update("\0");
      fichiers += 1;
    }
  };

  parcourir(dossierSrc, "");
  return { empreinte: hash.digest("hex"), fichiers };
}

/**
 * Dossier des sources vu depuis le code compilé, ou `null` hors dépôt.
 *
 * Deux dispositions coexistent et doivent toutes deux être reconnues, sans
 * quoi le garde-fou ne servirait que dans l'une d'elles :
 *
 *   - `sidecar/dist/index.js`                    → `../src`   (compilation directe) ;
 *   - `src-tauri/target/debug/sidecar/index.js`  → `<dépôt>/sidecar/src` (ressource Tauri).
 *
 * On remonte donc les parents en cherchant l'un ou l'autre. Une application
 * installée n'en trouve aucun : c'est voulu, elle n'a rien à comparer.
 */
export function trouverSources(dossierCompile: string): string | null {
  let courant = dossierCompile;
  for (let i = 0; i < REMONTEE_MAX; i += 1) {
    for (const candidat of [path.join(courant, "src"), path.join(courant, "sidecar", "src")]) {
      if (existsSync(path.join(candidat, "index.ts"))) return candidat;
    }
    const parent = path.dirname(courant);
    if (parent === courant) break;
    courant = parent;
  }
  return null;
}

export type StatutPeremption = "a-jour" | "perime" | "sans-empreinte" | "hors-source";

export interface EtatPeremption {
  statut: StatutPeremption;
  /** Dossier du code réellement exécuté — la première chose à regarder. */
  compile: string;
  /** Empreinte inscrite dans le code compilé (null si le témoin manque). */
  attendue: string | null;
  /** Empreinte recalculée depuis les sources (null hors dépôt). */
  actuelle: string | null;
  sources: string | null;
}

/** Dossier du code compilé courant (celui d'où ce module est chargé). */
function dossierCompileCourant(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function lireEmpreinteInscrite(dossierCompile: string): Empreinte | null {
  try {
    const brut = readFileSync(path.join(dossierCompile, NOM_EMPREINTE), "utf8");
    const parse: unknown = JSON.parse(brut);
    if (typeof parse === "object" && parse !== null) {
      const { empreinte, fichiers } = parse as Partial<Empreinte>;
      if (typeof empreinte === "string" && empreinte.length > 0) {
        return { empreinte, fichiers: typeof fichiers === "number" ? fichiers : 0 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compare le code exécuté aux sources, sans rien journaliser.
 *
 * Ne lève jamais : un garde-fou d'observabilité qui ferait tomber le sidecar
 * au démarrage serait une panne bien pire que celle qu'il surveille. Toute
 * anomalie de lecture se solde par `sans-empreinte` ou `hors-source`.
 */
export function inspecterPeremption(dossierCompile = dossierCompileCourant()): EtatPeremption {
  const inscrite = lireEmpreinteInscrite(dossierCompile);
  let sources: string | null = null;
  let actuelle: string | null = null;
  try {
    sources = trouverSources(dossierCompile);
    if (sources) actuelle = calculerEmpreinte(sources).empreinte;
  } catch {
    sources = null;
    actuelle = null;
  }

  const base = { compile: dossierCompile, attendue: inscrite?.empreinte ?? null, actuelle, sources };
  if (!inscrite) return { ...base, statut: "sans-empreinte" };
  if (!actuelle) return { ...base, statut: "hors-source" };
  return { ...base, statut: inscrite.empreinte === actuelle ? "a-jour" : "perime" };
}

/** Abrégé lisible dans une ligne de journal : une empreinte entière n'y sert à rien. */
function court(empreinte: string | null): string | null {
  return empreinte ? empreinte.slice(0, 12) : null;
}

/**
 * Inspecte ET journalise, au démarrage du sidecar.
 *
 * Le chemin du code exécuté figure dans TOUS les cas, y compris quand tout va
 * bien : le 10 août, c'est l'unique information qui aurait immédiatement
 * désigné le coupable, et personne ne l'avait sous les yeux.
 */
export function signalerPeremption(dossierCompile = dossierCompileCourant()): EtatPeremption {
  const etat = inspecterPeremption(dossierCompile);
  const fields = {
    compile: etat.compile,
    sources: etat.sources,
    empreinteCompilee: court(etat.attendue),
    empreinteSources: court(etat.actuelle),
  };

  switch (etat.statut) {
    case "perime":
      journal.error(
        "sidecar",
        "sidecar PÉRIMÉ : le code exécuté ne correspond pas aux sources du dépôt " +
          "(reconstruire avant tout diagnostic — voir T-020)",
        { fields },
      );
      break;
    case "sans-empreinte":
      journal.warn(
        "sidecar",
        "sidecar sans empreinte de compilation : âge du code exécuté inconnu (build antérieur à T-020)",
        { fields },
      );
      break;
    default:
      journal.info("sidecar", "sidecar à jour", { fields: { ...fields, statut: etat.statut } });
      break;
  }
  return etat;
}

/**
 * Dépose `empreinte.json` à côté du code compilé. Appelé par la compilation
 * (`sidecar/scripts/empreinte.mjs`), jamais à l'exécution.
 *
 * C'est le même `calculerEmpreinte` qui sert ici et à la vérification : une
 * seconde implémentation du hachage finirait par diverger de la première, et
 * un garde-fou qui se trompe tout seul est pire que pas de garde-fou.
 */
export function ecrireEmpreinte(dossierCompile = dossierCompileCourant()): Empreinte & { chemin: string } {
  const sources = trouverSources(dossierCompile);
  if (!sources) {
    throw new Error(`sources introuvables depuis ${dossierCompile} : empreinte impossible`);
  }
  const empreinte = calculerEmpreinte(sources);
  const chemin = path.join(dossierCompile, NOM_EMPREINTE);
  writeFileSync(chemin, `${JSON.stringify(empreinte, null, 2)}\n`, "utf8");
  return { ...empreinte, chemin };
}
