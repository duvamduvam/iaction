/*
 * Mémoire des fils du veilleur (veilleurFils.ts) — session par fil, cumul de
 * coût, profondeur maximale, destinataire, purge à 8 jours, persistance ;
 * table sans prototype ; seul un fichier ABSENT donne une mémoire neuve.
 *
 * Lancement isolé : node sidecar/test/veilleurFils.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { creerMemoireFils } = await import(moduleCompile("veilleurFils.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const JOUR = 24 * 60 * 60 * 1000;
const chemin = async () => path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-fils-")), "fils.json");

await cas("session mémorisée, relue par une autre instance, oubliée", async () => {
  const c = await chemin();
  await creerMemoireFils(c).memoriserSession("f1", "s-1");
  const m = creerMemoireFils(c);
  assert((await m.sessionDe("f1")) === "s-1", "relue");
  assert((await m.sessionDe("f2")) === null, "fil inconnu");
  await m.oublierSession("f1");
  assert((await creerMemoireFils(c).sessionDe("f1")) === null, "oubliée");
});

await cas("cumul de coût : gardé pour la session, remis à zéro sur une session neuve", async () => {
  const m = creerMemoireFils(await chemin());
  await m.memoriserSession("f1", "s-1");
  await m.memoriserCoutCumule("f1", 2.5);
  assert((await m.coutCumuleDe("f1")) === 2.5, "cumul");
  await m.memoriserSession("f1", "s-2");
  assert((await m.coutCumuleDe("f1")) === null, "session neuve : cumul neuf");
});

await cas("profondeur max et destinataire", async () => {
  const m = creerMemoireFils(await chemin());
  await m.memoriserProfondeur("f1", 3);
  await m.memoriserProfondeur("f1", 1);
  await m.memoriserDestinataire("f1", "bureau");
  assert((await m.profondeurDe("f1")) === 3 && (await m.destinataireDe("f1")) === "bureau", "gardés");
});

await cas("fil __proto__ : aucune pollution du prototype", async () => {
  const c = await chemin();
  const m = creerMemoireFils(c);
  await m.memoriserSession("__proto__", "s-x");
  assert(({}).sessionId === undefined && Object.prototype.sessionId === undefined, "prototype intact");
  assert((await creerMemoireFils(c).sessionDe("constructor")) === null, "constructor n'est pas une entrée");
});

await cas("purge au-delà de 8 jours", async () => {
  const c = await chemin();
  let t = Date.parse("2026-11-01T00:00:00Z");
  const m = creerMemoireFils(c, () => t);
  await m.memoriserSession("vieux", "s");
  t += 9 * JOUR;
  await m.memoriserSession("neuf", "s2");
  assert((await m.sessionDe("vieux")) === null && (await m.sessionDe("neuf")) === "s2", "purge");
});

await cas("fichier absent : mémoire neuve ; corrompu : la lecture LÈVE", async () => {
  const c = await chemin();
  assert((await creerMemoireFils(c).sessionDe("f")) === null, "absent : neuve");
  await fsp.writeFile(c, "pas du json");
  let leve = "";
  try {
    await creerMemoireFils(c).sessionDe("f");
  } catch (e) {
    leve = e.message;
  }
  assert(leve.includes("corrompue"), `lève (reçu ${leve})`);
});

console.log(`veilleurFils : ${ok} cas OK`);
