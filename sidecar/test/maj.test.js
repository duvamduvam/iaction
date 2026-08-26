/*
 * Comparaison de versions de la sonde de mise à jour (T-056).
 *
 * Ce que ces cas protègent : une sonde qui se trompe de sens invite à
 * « mettre à jour » vers une version plus ancienne, et une sonde qui ne sait
 * pas lire un numéro doit se TAIRE plutôt que d'inventer. Les deux erreurs
 * produisent la même chose à l'écran — un bandeau — mais l'une est un service
 * et l'autre un mensonge.
 *
 * Lancement isolé : node sidecar/test/maj.test.js
 */

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { enTriplet, estPlusRecente } = await import(moduleCompile("maj.js"));

await lancer("un numéro se lit avec ou sans le v de l'étiquette", async () => {
  assert(JSON.stringify(enTriplet("0.4.1")) === "[0,4,1]", "0.4.1 mal lu");
  assert(JSON.stringify(enTriplet("v0.4.1")) === "[0,4,1]", "v0.4.1 mal lu");
  assert(JSON.stringify(enTriplet(" 1.20.3 ")) === "[1,20,3]", "espaces mal tolérées");
});

await lancer("ce qui n'est pas X.Y.Z n'est pas un numéro", async () => {
  // « inconnue » est le repli du sidecar quand package.json est illisible : il
  // ne doit surtout pas se comparer comme un numéro.
  for (const brut of ["inconnue", "", "0.4", "0.4.1.2", "0.4.1-rc.1", "abc"]) {
    assert(enTriplet(brut) === null, `« ${brut} » aurait dû être refusé`);
  }
});

await lancer("le sens de la comparaison, champ par champ", async () => {
  assert(estPlusRecente("0.4.2", "0.4.1"), "correctif suivant non vu");
  assert(estPlusRecente("0.5.0", "0.4.9"), "mineure suivante non vue");
  assert(estPlusRecente("1.0.0", "0.99.99"), "majeure suivante non vue");
  // Le piège du tri alphabétique : « 0.10.0 » < « 0.9.0 » en texte.
  assert(estPlusRecente("0.10.0", "0.9.0"), "comparaison faite en texte, pas en nombres");
});

await lancer("à version égale, rien à proposer", async () => {
  assert(!estPlusRecente("0.4.1", "0.4.1"), "une version identique ne se propose pas");
});

await lancer("une distante PLUS ANCIENNE ne se propose jamais", async () => {
  // Cas réel : on tourne sur une construction locale en avance sur la
  // dernière release. Proposer « 0.4.0 » serait une régression déguisée.
  assert(!estPlusRecente("0.4.0", "0.5.0"), "rétrogradation proposée");
});

await lancer("un numéro illisible fait taire la sonde, des deux côtés", async () => {
  assert(!estPlusRecente("0.4.2", "inconnue"), "courante illisible : la sonde doit se taire");
  assert(!estPlusRecente("dernière", "0.4.1"), "distante illisible : la sonde doit se taire");
});
