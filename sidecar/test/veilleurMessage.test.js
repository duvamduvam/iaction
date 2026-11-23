/*
 * Format du message inter-studios (veilleurMessage.ts) — aller-retour de
 * sérialisation et lecture stricte des en-têtes invalides.
 *
 * Lancement isolé : node sidecar/test/veilleurMessage.test.js
 */

import { assert, fail, moduleCompile } from "./harness.mjs";

const { serialiserMessage, lireMessage, nomPieceSur } = await import(moduleCompile("veilleurMessage.js"));

let ok = 0;
const cas = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

cas("aller-retour d'un message complet", () => {
  const m = {
    fil: "7c1e",
    id: "4b09",
    type: "demande",
    profondeur: 2,
    enReponseA: "91aa",
    pieces: ["rapport.json"],
    corps: "Publie le site docs.",
  };
  const r = lireMessage(serialiserMessage(m));
  assert("message" in r, "message lu");
  assert(r.message.fil === "7c1e", "fil");
  assert(r.message.id === "4b09", "id");
  assert(r.message.type === "demande", "type");
  assert(r.message.profondeur === 2, "profondeur");
  assert(r.message.enReponseA === "91aa", "en_reponse_a");
  assert(r.message.pieces.length === 1 && r.message.pieces[0] === "rapport.json", "pieces");
  assert(r.message.corps === "Publie le site docs.", "corps");
});

cas("message minimal : ni pièces ni en_reponse_a", () => {
  const txt = serialiserMessage({ fil: "f", id: "i", type: "info", profondeur: 0, corps: "x" });
  const r = lireMessage(txt);
  assert("message" in r, "lu");
  assert(r.message.pieces === undefined, "pas de pieces");
  assert(r.message.enReponseA === undefined, "pas de en_reponse_a");
});

cas("un corps qui contient « --- » n'est pas tronqué", () => {
  const corps = "avant\n---\napres\n---\nfin";
  const r = lireMessage(serialiserMessage({ fil: "f", id: "i", type: "reponse", profondeur: 1, corps }));
  assert(r.message.corps === corps, "corps entier");
});

cas("CRLF toléré", () => {
  const txt = "---\r\nfil: f\r\nid: i\r\ntype: info\r\nprofondeur: 0\r\n---\r\ncorps";
  const r = lireMessage(txt);
  assert("message" in r, "lu");
  assert(r.message.corps === "corps", "corps");
});

for (const [nom, txt, attendu] of [
  ["sans en-tête", "pas de tiret", "en-tête absent"],
  ["en-tête non fermé", "---\nfil: f\n", "en-tête non fermé"],
  ["type inconnu", "---\nfil: f\nid: i\ntype: ordre\nprofondeur: 0\n---\nx", "type"],
  ["profondeur négative", "---\nfil: f\nid: i\ntype: info\nprofondeur: -1\n---\nx", "profondeur"],
  ["profondeur non entière", "---\nfil: f\nid: i\ntype: info\nprofondeur: 1.5\n---\nx", "profondeur"],
  ["fil manquant", "---\nid: i\ntype: info\nprofondeur: 0\n---\nx", "fil"],
  ["pièce avec chemin", "---\nfil: f\nid: i\ntype: info\nprofondeur: 0\npieces: ['../s']\n---\nx", "pieces"],
]) {
  cas(`invalide : ${nom}`, () => {
    const r = lireMessage(txt);
    assert("invalide" in r, "rejeté");
    assert(r.invalide.includes(attendu), `raison mentionne ${attendu} (reçu: ${r.invalide})`);
  });
}

cas("nomPieceSur rejette les chemins", () => {
  assert(nomPieceSur("rapport.json"), "basename ok");
  assert(!nomPieceSur("a/b"), "slash refusé");
  assert(!nomPieceSur("a\\b"), "backslash refusé");
  assert(!nomPieceSur(".."), "dotdot refusé");
  assert(!nomPieceSur(""), "vide refusé");
  assert(!nomPieceSur(3), "non-chaîne refusé");
});

cas("fil, id et en_reponse_a : segment sûr exigé (T-227)", () => {
  const base = (over) => serialiserMessage({ fil: "f", id: "i", type: "demande", profondeur: 0, corps: "x", ...over });
  for (const [quoi, over] of [
    ["fil __proto__", { fil: "__proto__" }],
    ["fil constructor", { fil: "constructor" }],
    ["fil prototype", { fil: "prototype" }],
    ["fil chemin", { fil: "../x" }],
    ["id avec barre", { id: "a/b" }],
    ["id __proto__", { id: "__proto__" }],
    ["en_reponse_a chemin", { enReponseA: "../q" }],
  ]) {
    const r = lireMessage(base(over));
    assert("invalide" in r, `${quoi} refusé`);
  }
  assert("message" in lireMessage(base({ fil: "7c1e-4b09_x.1" })), "identifiant ordinaire accepté");
});

console.log(`veilleurMessage : ${ok} cas OK`);
