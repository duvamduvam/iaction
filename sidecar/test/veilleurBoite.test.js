/*
 * Client de boîte réel (veilleurBoite.ts) — construction des requêtes et
 * lecture des réponses, avec une fonction de requête injectée (pas de réseau).
 *
 * Lancement isolé : node sidecar/test/veilleurBoite.test.js
 */

import { assert, fail, moduleCompile } from "./harness.mjs";

const { creerClientBoite } = await import(moduleCompile("veilleurBoite.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const cfg = { url: new URL("https://relay.example.net"), jeton: "SECRET" };
const rep = (statut, corps) => ({ statut, corps: Buffer.from(corps, "utf8") });

await cas("listerRecus lit .fichiers et porte le Bearer", async () => {
  let vue;
  const requete = async (r) => {
    vue = r;
    return rep(200, JSON.stringify({ fichiers: [{ nom: "msg-1.md", de: "maison" }, { nom: "x", de: "maison" }] }));
  };
  const c = creerClientBoite(cfg, requete);
  const l = await c.listerRecus();
  assert(vue.methode === "GET", "GET");
  assert(vue.url.pathname.endsWith("/boites"), "route /boites");
  assert(vue.entetes.Authorization === "Bearer SECRET", "Bearer");
  assert(l.length === 2 && l[0].nom === "msg-1.md" && l[0].de === "maison", "fichiers mappés");
});

await cas("listerRecus rend taille et date de dépôt (contrôle de substitution)", async () => {
  const c = creerClientBoite(cfg, async () => rep(200, JSON.stringify({ fichiers: [{ nom: "msg-1.md", de: "maison", taille: 42, depose_le: 1763600000 }, { nom: "x", de: "maison" }] })));
  const l = await c.listerRecus();
  assert(l[0].taille === 42 && l[0].deposeLe === 1763600000, "champs repris");
  assert(l[1].taille === undefined && l[1].deposeLe === undefined, "absents restent absents");
});

await cas("listerRecus tolère l'absence de fichiers", async () => {
  const c = creerClientBoite(cfg, async () => rep(200, JSON.stringify({ studio: "poste" })));
  assert((await c.listerRecus()).length === 0, "liste vide");
});

await cas("telecharger rend le texte", async () => {
  let vue;
  const c = creerClientBoite(cfg, async (r) => ((vue = r), rep(200, "contenu")));
  const t = await c.telecharger("msg-1.md");
  assert(t === "contenu", "texte");
  assert(vue.url.pathname.endsWith("/boites/msg-1.md"), "route du fichier");
});

await cas("deposer POST multipart chez le destinataire", async () => {
  let vue;
  const c = creerClientBoite(cfg, async (r) => ((vue = r), rep(201, "{}")));
  await c.deposer("Maison", "msg-2.md", "corps");
  assert(vue.methode === "POST", "POST");
  assert(vue.url.pathname.endsWith("/boites/maison"), "destinataire minuscule");
  assert(String(vue.entetes["Content-Type"]).includes("multipart/form-data"), "multipart");
  assert(vue.corps.includes(Buffer.from("msg-2.md")), "nom du fichier dans le corps");
});

await cas("supprimer DELETE", async () => {
  let vue;
  const c = creerClientBoite(cfg, async (r) => ((vue = r), rep(200, "{}")));
  await c.supprimer("msg-1.md");
  assert(vue.methode === "DELETE", "DELETE");
  assert(vue.url.pathname.endsWith("/boites/msg-1.md"), "route");
});

await cas("telechargerBrut et deposerBrut gardent les octets", async () => {
  const octets = Buffer.from([0, 255, 10, 13, 128]);
  let vue;
  const c = creerClientBoite(cfg, async (r) => ((vue = r), { statut: r.methode === "GET" ? 200 : 201, corps: octets }));
  const lu = await c.telechargerBrut("m1-x.bin");
  assert(Buffer.compare(lu, octets) === 0, "octets rendus tels quels");
  await c.deposerBrut("Bureau", "m1-x.bin", octets);
  assert(vue.methode === "POST" && vue.url.pathname.endsWith("/boites/bureau"), "dépôt chez le destinataire");
  assert(vue.corps.includes(octets), "octets dans le multipart");
});

await cas("statut non-2xx lève", async () => {
  const c = creerClientBoite(cfg, async () => rep(403, "token sans boite"));
  let leve = false;
  try {
    await c.listerRecus();
  } catch (e) {
    leve = true;
    assert(e.message.includes("403"), "message porte le statut");
  }
  assert(leve, "a levé");
});

console.log(`veilleurBoite : ${ok} cas OK`);
