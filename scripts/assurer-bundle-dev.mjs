#!/usr/bin/env node
/**
 * S'assure que `build/sidecar-bundle/` existe avant que cargo ne lance son
 * build script (T-127).
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * `src-tauri/tauri.conf.json` déclare `../build/sidecar-bundle/` en ressource
 * Tauri. Ce dossier n'est produit que par `scripts/preparer-bundle.sh`, appelé
 * par `beforeBuildCommand` — donc UNIQUEMENT à l'empaquetage. Il est dans
 * `.gitignore` : un clone neuf, ou un `target/` reconstruit, n'en garde pas la
 * moindre trace. Le build script de cargo, lui, vérifie l'existence de cette
 * ressource même en développement (`tauri dev` compile aussi le binaire
 * Rust) — et échoue :
 *
 *     resource path `../build/sidecar-bundle` doesn't exist
 *
 * En développement, le sidecar exécuté ne vient PAS de ce dossier : il est
 * désigné explicitement par `IACTION_SIDECAR` (T-020, voir `scripts/dev.sh`).
 * Le dossier n'a donc besoin d'EXISTER que pour satisfaire cargo — un dossier
 * vide avec un témoin suffit, et surtout PAS l'empaquetage complet (139 Mo,
 * 40 s) à chaque lancement en développement.
 *
 * ── Ce qu'on ne fait JAMAIS ───────────────────────────────────────────────
 * Si un vrai bundle est déjà là (parce que `npm run preparer-bundle` a tourné
 * avant), on ne touche à rien : écraser reviendrait à jeter un travail déjà
 * fait pour le remplacer par un témoin vide.
 *
 * Séparé de `dev.sh` (bash, non testable simplement) pour pouvoir exercer la
 * décision sans lancer `tauri dev` — même logique que `session-en-cours.mjs`.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NOM_TEMOIN = "CECI-N-EST-PAS-LE-BUNDLE.txt";

const CONTENU_TEMOIN = `Ce dossier n'est PAS le bundle d'empaquetage.

En développement, le sidecar exécuté vient de sidecar/dist-dev/ : il est
désigné explicitement par IACTION_SIDECAR (T-020, voir scripts/dev.sh),
jamais par ce dossier.

Ce dossier existe uniquement pour que le build script de cargo trouve la
ressource déclarée par src-tauri/tauri.conf.json (../build/sidecar-bundle/) :
sans lui, la compilation échoue dès que target/ est reconstruit (T-127),
alors même que rien, en développement, ne lit son contenu.

Le vrai bundle — celui embarqué dans l'application empaquetée — est produit
par : npm run preparer-bundle
`;

/**
 * @param {string} bundleDir chemin absolu de `build/sidecar-bundle`
 * @returns {Promise<{action: "cree"|"deja-present", detail: string}>}
 */
export async function assurerBundleDev(bundleDir) {
  let entrees;
  try {
    entrees = await fsp.readdir(bundleDir);
  } catch {
    entrees = null; // dossier absent
  }

  if (entrees !== null && entrees.length > 0) {
    return {
      action: "deja-present",
      detail: `${bundleDir} contient déjà ${entrees.length} entrée(s) — rien à faire.`,
    };
  }

  await fsp.mkdir(bundleDir, { recursive: true });
  await fsp.writeFile(path.join(bundleDir, NOM_TEMOIN), CONTENU_TEMOIN);
  return {
    action: "cree",
    detail: `${bundleDir} créé avec un témoin (T-127) — le vrai bundle vient de "npm run preparer-bundle".`,
  };
}

// Exécuté seulement en ligne de commande : importé par son test, il ne fait rien.
if (process.argv[1] && process.argv[1].endsWith("assurer-bundle-dev.mjs")) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const racine = path.dirname(__dirname);
  const bundleDir = path.join(racine, "build", "sidecar-bundle");
  const { action, detail } = await assurerBundleDev(bundleDir);
  if (action === "cree") {
    console.log(`==> Ressource cargo créée (dossier vide + témoin) : ${detail}`);
  } else {
    console.log(`==> Ressource cargo déjà présente : ${detail}`);
  }
}
