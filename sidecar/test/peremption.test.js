/*
 * Le sidecar détecte-t-il qu'il exécute du code périmé ? (T-020)
 *
 * La panne du 2026-08-10 : l'application tournait sur un sidecar du 7 août,
 * trois jours de correctifs n'étaient jamais exécutés, et RIEN ne le disait —
 * ni le journal, ni les tests, qui compilent leur propre sortie et passaient
 * donc au vert sur du code que l'application n'utilisait pas.
 *
 * On vérifie ici les quatre issues du garde-fou, plus la propriété qui le rend
 * fiable : l'empreinte porte sur le CONTENU et les NOMS des sources, jamais
 * sur des dates de fichiers — c'est précisément une date de recopie,
 * postérieure aux sources qu'elle ignorait, qui avait masqué la panne.
 *
 * Lancement isolé : node sidecar/test/peremption.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, lancer, moduleCompile } from "./harness.mjs";

const {
  NOM_EMPREINTE,
  calculerEmpreinte,
  ecrireEmpreinte,
  inspecterPeremption,
  trouverSources,
} = await import(moduleCompile("peremption.js"));

/**
 * Faux dépôt jetable : `<racine>/sidecar/src` (les sources) et un dossier de
 * code compilé, dans la disposition exacte que le garde-fou doit reconnaître.
 */
async function fauxDepot(sousDossierCompile) {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-peremption-"));
  const src = path.join(racine, "sidecar", "src");
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, "index.ts"), "export const a = 1;\n", "utf8");
  await fsp.writeFile(path.join(src, "autre.ts"), "export const b = 2;\n", "utf8");
  const compile = path.join(racine, sousDossierCompile);
  await fsp.mkdir(compile, { recursive: true });
  return { racine, src, compile };
}

await lancer("empreinte : stable, et sensible au contenu comme aux noms", async () => {
  const { src } = await fauxDepot("sidecar/dist");

  const initiale = calculerEmpreinte(src);
  assert(initiale.fichiers === 2, `2 sources attendues, vu ${initiale.fichiers}`);
  assert(
    calculerEmpreinte(src).empreinte === initiale.empreinte,
    "deux calculs successifs sur les mêmes sources doivent donner la même empreinte",
  );

  // Contenu modifié → empreinte différente.
  await fsp.writeFile(path.join(src, "autre.ts"), "export const b = 3;\n", "utf8");
  const modifiee = calculerEmpreinte(src).empreinte;
  assert(modifiee !== initiale.empreinte, "un contenu modifié doit changer l'empreinte");

  // Module RENOMMÉ, contenu global inchangé : c'est le cas réel (un
  // `claudeFinDeTour.ts` absent du bundle). Le chemin entre dans le hachage,
  // donc l'empreinte bouge.
  await fsp.rename(path.join(src, "autre.ts"), path.join(src, "renomme.ts"));
  assert(
    calculerEmpreinte(src).empreinte !== modifiee,
    "un module renommé doit changer l'empreinte, même à contenu identique",
  );

  // Module SUPPRIMÉ.
  await fsp.rm(path.join(src, "renomme.ts"));
  const apresSuppression = calculerEmpreinte(src);
  assert(apresSuppression.fichiers === 1, "le compte de fichiers doit suivre les suppressions");
});

await lancer("les deux dispositions de code compilé retrouvent les sources", async () => {
  // Compilation directe : sidecar/dist → ../src
  const direct = await fauxDepot(path.join("sidecar", "dist"));
  assert(
    trouverSources(direct.compile) === direct.src,
    `sources non retrouvées depuis ${direct.compile}`,
  );

  // Ressource Tauri : src-tauri/target/debug/sidecar → <dépôt>/sidecar/src
  const tauri = await fauxDepot(path.join("src-tauri", "target", "debug", "sidecar"));
  assert(
    trouverSources(tauri.compile) === tauri.src,
    `sources non retrouvées depuis ${tauri.compile}`,
  );

  // Hors dépôt : rien à comparer, et surtout aucune fausse alerte.
  const isole = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-peremption-isole-"));
  assert(trouverSources(isole) === null, "hors dépôt, aucune source ne doit être « trouvée »");
});

await lancer("les quatre statuts de péremption", async () => {
  const { src, compile } = await fauxDepot(path.join("sidecar", "dist"));

  // 1. Aucun témoin déposé : âge inconnu (c'est le bundle du 7 août).
  assert(
    inspecterPeremption(compile).statut === "sans-empreinte",
    "sans empreinte.json, le statut doit être « sans-empreinte »",
  );

  // 2. Témoin fraîchement écrit : à jour.
  const ecrite = ecrireEmpreinte(compile);
  assert(
    ecrite.chemin === path.join(compile, NOM_EMPREINTE),
    `témoin déposé au mauvais endroit : ${ecrite.chemin}`,
  );
  const aJour = inspecterPeremption(compile);
  assert(aJour.statut === "a-jour", `statut « a-jour » attendu, vu « ${aJour.statut} »`);
  assert(aJour.attendue === aJour.actuelle, "les deux empreintes doivent coïncider");

  // 3. Les sources avancent, le code compilé reste en arrière : PÉRIMÉ.
  //    On ajoute un module — exactement ce qui s'est passé le 9 août.
  await fsp.writeFile(path.join(src, "correctif.ts"), "export const c = 3;\n", "utf8");
  const perime = inspecterPeremption(compile);
  assert(perime.statut === "perime", `statut « perime » attendu, vu « ${perime.statut} »`);
  assert(perime.compile === compile, "l'état doit nommer le code réellement exécuté");
  assert(perime.sources === src, "l'état doit nommer les sources comparées");

  // 4. Hors dépôt : le témoin existe, les sources non → aucune alerte.
  const isole = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-peremption-hors-"));
  await fsp.copyFile(path.join(compile, NOM_EMPREINTE), path.join(isole, NOM_EMPREINTE));
  assert(
    inspecterPeremption(isole).statut === "hors-source",
    "une application installée ne doit jamais être déclarée périmée",
  );
});

await lancer("un témoin illisible ne fait pas tomber le sidecar", async () => {
  const { compile } = await fauxDepot(path.join("sidecar", "dist"));
  await fsp.writeFile(path.join(compile, NOM_EMPREINTE), "{ ceci n'est pas du JSON", "utf8");
  assert(
    inspecterPeremption(compile).statut === "sans-empreinte",
    "un témoin corrompu doit se traiter comme un témoin absent, sans exception",
  );
});

await lancer("le code compilé par la suite de tests est à jour", async () => {
  // Vérification de bout en bout du câblage réel : `npm test -w sidecar`
  // compile `dist-verif/` PUIS y dépose l'empreinte. Si ce test échoue, c'est
  // que la compilation n'écrit plus le témoin — et le garde-fou serait aveugle
  // là où il compte, en production comme en développement.
  // `fileURLToPath` et non `new URL(...).pathname` : sous Windows ce dernier
  // rend « /D:/a/… », avec une barre de tête que Node ne sait pas relire — le
  // dossier paraissait alors vide, donc « sans-empreinte », et le test
  // échouait sur le seul runner Windows (T-037, même famille que T-014).
  const etat = inspecterPeremption(path.dirname(fileURLToPath(moduleCompile("peremption.js"))));
  assert(
    etat.statut === "a-jour",
    `la compilation de test doit se déclarer à jour, vu « ${etat.statut} » (${etat.compile})`,
  );
});
