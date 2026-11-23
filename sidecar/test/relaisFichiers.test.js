/*
 * Règles de fichiers du relais (relaisFichiers.ts), partagées par le serveur
 * relais et le veilleur : réception sous relais-recu/[<fil>/], sans écrasement,
 * secrets refusés, consignes renommées, liens symboliques qui sortent refusés ;
 * contrôle de dépôt (secrets, hors racine, valeurs connues).
 *
 * Lancement isolé : node sidecar/test/relaisFichiers.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { ecrireRecu, controlerDepot, segmentSur, dossierReception, nomDeReception } = await import(moduleCompile("relaisFichiers.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const projet = async () => fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "relais-fichiers-")));

await cas("réception dans relais-recu/<fil>/, sans écrasement", async () => {
  const d = await projet();
  const a = await ecrireRecu(d, "fil-1", "rapport.json", Buffer.from("a"));
  const b = await ecrireRecu(d, "fil-1", "rapport.json", Buffer.from("b"));
  assert(a.relatif === path.join("relais-recu", "fil-1", "rapport.json"), `chemin (reçu ${a.relatif})`);
  assert(b.relatif === path.join("relais-recu", "fil-1", "rapport-1.json"), "second nom libre");
  assert((await fsp.readFile(path.join(d, a.relatif), "utf8")) === "a", "premier intact");
});

await cas("secret refusé, consigne renommée .recu", async () => {
  const d = await projet();
  const s = await ecrireRecu(d, "f", ".env", Buffer.from("X=1"));
  assert("refus" in s, "secret refusé");
  const c = await ecrireRecu(d, "f", "CLAUDE.md", Buffer.from("# consignes"));
  assert(c.relatif.endsWith("CLAUDE.md.recu"), "consigne renommée");
});

await cas("fil non sûr refusé (pas de sortie du dossier)", async () => {
  const d = await projet();
  for (const fil of ["..", "../x", "a/b", "", "a\\b"]) {
    const r = await ecrireRecu(d, fil, "x.txt", Buffer.from("x"));
    assert("refus" in r, `fil ${JSON.stringify(fil)} refusé`);
  }
  assert(segmentSur("7c1e-4b09_ab.1"), "uuid-like accepté");
});

await cas("relais-recu en lien symbolique vers l'extérieur : refusé", async () => {
  const d = await projet();
  const dehors = await projet();
  await fsp.symlink(dehors, path.join(d, "relais-recu"));
  const r = await dossierReception(d, "f");
  assert(typeof r !== "string" && r.refus.includes("hors du projet"), "refusé");
  const e = await ecrireRecu(d, "f", "x.txt", Buffer.from("x"));
  assert("refus" in e, "rien écrit");
  assert((await fsp.readdir(dehors)).length === 0, "rien créé dehors, pas même un dossier");
});

await cas("dépôt : secret, hors racine, consigne, valeur connue refusés ; fichier sain accepté", async () => {
  const d = await projet();
  await fsp.writeFile(path.join(d, ".env"), "X=1");
  await fsp.writeFile(path.join(d, "CLAUDE.md"), "x");
  await fsp.writeFile(path.join(d, "fuite.txt"), "le jeton VALEUR-SECRETE-123 est là");
  await fsp.writeFile(path.join(d, "sain.txt"), "rien");
  const dehors = await projet();
  await fsp.writeFile(path.join(dehors, "x.txt"), "x");
  await fsp.symlink(path.join(dehors, "x.txt"), path.join(d, "lien.txt"));
  assert("refus" in (await controlerDepot(d, ".env")), ".env");
  assert("refus" in (await controlerDepot(d, "CLAUDE.md")), "consigne");
  assert("refus" in (await controlerDepot(d, "../x.txt")), "hors racine");
  assert("refus" in (await controlerDepot(d, "lien.txt")), "lien qui sort");
  const f = await controlerDepot(d, "fuite.txt", ["VALEUR-SECRETE-123"]);
  assert("refus" in f && !f.refus.includes("VALEUR-SECRETE-123"), "valeur connue refusée sans être citée");
  const s = await controlerDepot(d, "sain.txt", ["VALEUR-SECRETE-123"]);
  assert(!("refus" in s) && s.nom === "sain.txt" && s.contenu.toString() === "rien", "sain accepté");
});

await cas("réception : noms réservés Windows refusés, points et espaces finaux retirés AVANT le test des consignes", async () => {
  for (const n of ["CON", "nul.txt", "Com1", "LPT9.log", "aux.tar.gz", "prn."]) {
    assert("refus" in nomDeReception(n), `${n} refusé`);
  }
  assert(nomDeReception("CLAUDE.md.") === "CLAUDE.md.recu", "consigne à point final renommée");
  assert(nomDeReception("AGENTS.md  ") === "AGENTS.md.recu", "consigne à espaces finaux renommée");
  assert("refus" in nomDeReception(".env. "), ".env à point final refusé");
  assert(nomDeReception("console.txt") === "console.txt", "nom ordinaire gardé");
});

await cas("dépôt : un fichier msg-*.md ne part jamais à la main", async () => {
  const d = await projet();
  await fsp.writeFile(path.join(d, "msg-forge.md"), "---\nfil: f\n---\n");
  const r = await controlerDepot(d, "msg-forge.md");
  assert("refus" in r && r.refus.includes("relais_demander"), `refusé (reçu ${JSON.stringify(r)})`);
});

console.log(`relaisFichiers : ${ok} cas OK`);
