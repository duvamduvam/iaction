/*
 * État persistant du veilleur (veilleurEtat.ts) — statuts par id (en-cours,
 * repondu), réponse gardée tant qu'elle n'est pas déposée, purge à 8 jours,
 * quota rattaché au jour, suspension, persistance ; seul un fichier ABSENT
 * donne un état neuf ; le cache n'est muté qu'après l'écriture réussie.
 *
 * Lancement isolé : node sidecar/test/veilleurEtat.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { creerEtatFichier } = await import(moduleCompile("veilleurEtat.js"));

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
const meta = (id) => ({ id, nom: `msg-${id}.md`, de: "maison", fil: "f1", profondeur: 0 });

async function cheminTemp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-etat-"));
  return path.join(d, "etat.json");
}

await cas("en-cours, réponse gardée, puis répondu ; relu par une autre instance", async () => {
  const c = await cheminTemp();
  const e = creerEtatFichier(c);
  await e.marquerEnCours(meta("m1"));
  assert((await e.statutDe("m1")) === "en-cours", "en-cours");
  await e.preparerReponse("m1", { dest: "maison", nom: "msg-r.md", contenu: "corps" });
  const e2 = creerEtatFichier(c);
  const enCours = await e2.enCours();
  assert(enCours.length === 1 && enCours[0].reponse.contenu === "corps" && enCours[0].nom === "msg-m1.md", "réponse gardée sur disque");
  await e2.marquerRepondu("m1");
  const e3 = creerEtatFichier(c);
  assert((await e3.statutDe("m1")) === "repondu" && (await e3.enCours()).length === 0, "répondu, plus en attente");
  assert((await e3.idsTraites()).includes("m1"), "id traité");
});

await cas("un id n'est pas dupliqué", async () => {
  const e = creerEtatFichier(await cheminTemp());
  await e.marquerEnCours(meta("m1"));
  await e.marquerEnCours(meta("m1"));
  assert((await e.idsTraites()).filter((x) => x === "m1").length === 1, "une seule fois");
});

await cas("purge au-delà de 8 jours", async () => {
  const c = await cheminTemp();
  let t = Date.parse("2026-11-01T12:00:00Z");
  const e = creerEtatFichier(c, () => t);
  await e.marquerEnCours(meta("vieux"));
  t += 9 * JOUR;
  await e.marquerEnCours(meta("neuf"));
  const ids = await e.idsTraites();
  assert(!ids.includes("vieux") && ids.includes("neuf"), "vieux purgé, neuf gardé");
});

await cas("quota : 0 au départ, incrément, reset au changement de jour", async () => {
  const c = await cheminTemp();
  let t = Date.parse("2026-11-20T10:00:00Z");
  const e = creerEtatFichier(c, () => t);
  assert((await e.toursAujourdhui()) === 0, "0 au départ");
  await e.incrementerTour();
  await e.incrementerTour();
  assert((await e.toursAujourdhui()) === 2, "2 après deux tours");
  t += JOUR;
  assert((await e.toursAujourdhui()) === 0, "reset le lendemain");
  await e.incrementerTour();
  assert((await e.toursAujourdhui()) === 1, "repart à 1");
});

await cas("suspension : posée, persistée, levée", async () => {
  const c = await cheminTemp();
  const t = Date.parse("2026-11-20T10:00:00Z");
  const e1 = creerEtatFichier(c, () => t);
  assert((await e1.suspension()) === null, "aucune au départ");
  await e1.suspendre("coût dépassé");
  const s = await creerEtatFichier(c, () => t).suspension();
  assert(s !== null && s.motif === "coût dépassé" && s.le === "2026-11-20T10:00:00.000Z", "relue après redémarrage");
  const e2 = creerEtatFichier(c, () => t);
  await e2.lever();
  assert((await creerEtatFichier(c, () => t).suspension()) === null, "levée et persistée");
});

await cas("fichier absent : état neuf ; corrompu ou illisible : la lecture LÈVE", async () => {
  const c = await cheminTemp();
  assert((await creerEtatFichier(c).idsTraites()).length === 0, "absent : neuf");
  await fsp.writeFile(c, "pas du json", "utf8");
  let leve = "";
  try {
    await creerEtatFichier(c).idsTraites();
  } catch (e) {
    leve = e.message;
  }
  assert(leve.includes("corrompu"), `corrompu lève (reçu ${leve})`);
  const d = await cheminTemp();
  await fsp.mkdir(d); // un dossier à la place du fichier : EISDIR
  let leve2 = "";
  try {
    await creerEtatFichier(d).idsTraites();
  } catch (e) {
    leve2 = e.message;
  }
  assert(leve2.includes("illisible"), `illisible lève (reçu ${leve2})`);
});

await cas("écriture en échec : la mutation lève et le cache n'a PAS bougé", async () => {
  const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-etat-ro-"));
  const c = path.join(dossier, "etat.json");
  const e = creerEtatFichier(c);
  await e.marquerEnCours(meta("m1"));
  // Le fichier temporaire ne peut plus être créé : un dossier porte son nom.
  await fsp.mkdir(`${c}.${process.pid}.tmp`);
  let leve = false;
  try {
    await e.marquerRepondu("m1");
  } catch {
    leve = true;
  }
  assert(leve, "la mutation lève");
  assert((await e.statutDe("m1")) === "en-cours", "le cache dit toujours la vérité du disque");
});

console.log(`veilleurEtat : ${ok} cas OK`);
