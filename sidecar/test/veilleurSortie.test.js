/*
 * Pièces dans la réponse du veilleur (T-230) : dossier de sortie
 * `relais-envoi/<id>/`, collecte contrôlée, dépôt avant le message, retrait.
 * Vrai disque (dossier temporaire) pour la collecte, boîte et moteur factices
 * pour le cycle. La lecture côté maison passe par l'outil existant
 * (`relaisReponse`).
 *
 * Lancement isolé : node sidecar/test/veilleurSortie.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { uneReleve } = await import(moduleCompile("veilleurCycle.js"));
const { serialiserMessage, lireMessage } = await import(moduleCompile("veilleurMessage.js"));
const { collecterSortie, preparerSortie, supprimerSortie, nettoyerSorties, dossierDe } = await import(moduleCompile("veilleurSortie.js"));
const { motifSecretDansContenu } = await import(moduleCompile("fichiersSecrets.js"));
const { segmentSur } = await import(moduleCompile("segmentsSurs.js"));
const { creerEtatFichier } = await import(moduleCompile("veilleurEtat.js"));
const { relaisReponse } = await import(moduleCompile("outilsRelaisVeilleur.js"));
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

const COFFRE = "VALEUR-COFFRE-ABCDEFGH";
const plafonds = { profondeur: 6, coutParMessage: 5, toursParJour: 100 };
const config = { expediteurs: ["maison"], plafonds };
const silence = () => {};
const existe = (p) => fsp.lstat(p).then(() => true, () => false);

/** Boîte du poste veilleur : fichiers reçus, et tout ce qui est déposé, dans l'ordre. */
function fausseBoite(fichiers) {
  const actions = [];
  const b = {
    actions,
    echecPiece: new Set(),
    echecMessage: 0,
    horsService: false,
    async listerRecus() {
      return Object.entries(fichiers).map(([nom, v]) => ({ nom, de: v.de, taille: Buffer.byteLength(v.contenu), deposeLe: 1 }));
    },
    async telecharger(nom) {
      return fichiers[nom].contenu;
    },
    async telechargerBrut(nom) {
      return Buffer.from(fichiers[nom].contenu);
    },
    async deposer(dest, nom, contenu) {
      if (b.echecMessage > 0) {
        b.echecMessage -= 1;
        throw new Error("boîte injoignable");
      }
      actions.push({ type: "deposer", dest, nom, contenu });
    },
    async deposerBrut(dest, nom, contenu) {
      if ([...b.echecPiece].some((x) => nom.endsWith(`-${x}`))) throw Object.assign(new Error("EBUSY: resource busy, open '/srv/prive/chemin-du-poste/x.bin'"), { code: "EBUSY" });
      if (b.horsService) throw new Error("hors service");
      actions.push({ type: "deposerBrut", dest, nom, contenu });
    },
    async supprimer(nom) {
      actions.push({ type: "supprimer", nom });
      delete fichiers[nom];
    },
  };
  return b;
}

/** État en mémoire (même contrat que veilleurEtat.ts). */
function fauxEtat() {
  const entrees = new Map();
  return {
    entrees,
    async idsTraites() {
      return [...entrees.keys()];
    },
    async statutDe(id) {
      return entrees.get(id)?.statut ?? null;
    },
    async marquerEnCours(m) {
      if (!entrees.has(m.id)) entrees.set(m.id, { ...m, statut: "en-cours" });
    },
    appelsPreparer: 0,
    echecAuAppel: 0,
    async preparerReponse(id, r) {
      this.appelsPreparer += 1;
      if (this.echecAuAppel === this.appelsPreparer) throw new Error("disque plein");
      const x = entrees.get(id);
      if (x && x.statut === "en-cours") x.reponse = r;
    },
    async marquerRepondu(id) {
      const x = entrees.get(id);
      if (x) {
        x.statut = "repondu";
        delete x.reponse;
      }
    },
    async enCours() {
      return [...entrees.values()].filter((x) => x.statut === "en-cours").map((x) => ({ ...x }));
    },
    async toursAujourdhui() {
      return 0;
    },
    async incrementerTour() {},
    async suspension() {
      return null;
    },
    async suspendre() {},
    async lever() {},
  };
}

let seq = 0;
const nouvelId = () => `rep${(seq += 1)}`;
const demande = serialiserMessage({ fil: "f1", id: "m1", type: "demande", profondeur: 0, corps: "publie" });

/**
 * Un poste veilleur : projet temporaire, boîte, état ; `ecrire(dossierSortie)` est ce
 * que fait l'agent pendant le tour. Les trois dépendances de sortie sont les
 * VRAIES (veilleurSortie.ts), avec les valeurs du coffre.
 */
async function posteVeilleur(ecrire, issue = { corps: "fait", coutUsd: 0.1 }, surDeps = {}) {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-sortie-")));
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: demande } });
  const etat = fauxEtat();
  const journal = [];
  const compte = { collectes: 0 };
  const deps = {
    boite,
    etat,
    config,
    nouvelId,
    journal: (niveau, message, champs) => journal.push({ niveau, message, champs }),
    lancer: async (_m, _de, ctx) => {
      if (ctx.sortie && ecrire) await ecrire(path.join(cwd, ctx.sortie), cwd);
      return typeof issue === "function" ? issue() : issue;
    },
    valeursSecretes: async () => [COFFRE],
    preparerSortie: (id) => preparerSortie(cwd, id),
    collecterSortie: (id) => ((compte.collectes += 1), collecterSortie(cwd, id, [COFFRE])),
    supprimerSortie: (id) => supprimerSortie(cwd, id),
    ...surDeps,
  };
  return { cwd, boite, etat, journal, compte, deps };
}

const messageDepose = (boite) => {
  const d = boite.actions.find((a) => a.type === "deposer");
  assert(d, "message déposé");
  const lu = lireMessage(d.contenu);
  assert("message" in lu, "message lisible");
  return lu.message;
};
const piecesDeposees = (boite) => boite.actions.filter((a) => a.type === "deposerBrut");

await cas("pièce renvoyée : déposée avant le message, lisible côté maison, dossier retiré", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "rapport.txt"), "résultat du poste"));
  const bilan = await uneReleve(b.deps);
  assert(bilan.traites.length === 1, "demande traitée");
  const ordre = b.boite.actions.map((a) => a.type).join(",");
  assert(ordre === "deposerBrut,deposer,supprimer", `pièce AVANT le message (reçu ${ordre})`);
  const m = messageDepose(b.boite);
  assert(m.pieces?.length === 1 && m.pieces[0] === "rapport.txt", `en-tête : ${JSON.stringify(m.pieces)}`);
  const [p] = piecesDeposees(b.boite);
  assert(p.dest === "maison" && p.nom === `${m.id}-rapport.txt`, `nom en boîte (reçu ${p.nom})`);
  assert(!(await existe(path.join(b.cwd, "relais-envoi", dossierDe("m1")))), "dossier de sortie supprimé après le dépôt");
  assert(b.journal.every((l) => l.niveau !== "warn"), "aucun avertissement");

  // Côté maison : l'outil existant reçoit la réponse et sa pièce.
  const maison = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "maison-")));
  const recus = new Map([
    [`msg-${m.id}.md`, { de: "poste", contenu: Buffer.from(b.boite.actions.find((a) => a.type === "deposer").contenu) }],
    [p.nom, { de: "poste", contenu: p.contenu }],
  ]);
  const boiteMaison = {
    async listerRecus() {
      return [...recus.entries()].map(([nom, v]) => ({ nom, de: v.de }));
    },
    async telechargerBrut(nom) {
      return recus.get(nom).contenu;
    },
    async supprimer(nom) {
      recus.delete(nom);
    },
  };
  const fils = creerMemoireFils(path.join(maison, "fils.json"));
  await fils.memoriserDestinataire("f1", "poste");
  const r = await relaisReponse(
    { fil: "f1" },
    { cwd: maison, lireConfig: async () => ({ config: { ...config, actif: false, expediteurs: ["poste"], url: "https://relay.example.net", jetonSecret: "j" } }), secrets: async () => ({ j: "JETON-0123456789" }), etatCoffre: () => "ouvert", client: () => boiteMaison, fils, scelle: () => true },
  );
  assert(!r.erreur && r.texte.includes(path.join("relais-recu", "f1", "rapport.txt")), r.texte);
  assert((await fsp.readFile(path.join(maison, "relais-recu", "f1", "rapport.txt"), "utf8")) === "résultat du poste", "contenu intact côté maison");
});

await cas("secret dans une pièce : refusée et dite dans le corps, sans citer la valeur", async () => {
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, "ok.txt"), "propre");
    await fsp.writeFile(path.join(d, "fuite.txt"), `clé = ${COFFRE}`);
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["ok.txt"]), `seule la propre part (reçu ${JSON.stringify(m.pieces)})`);
  assert(m.corps.includes("Pièces non envoyées :") && m.corps.includes("- fuite.txt :"), m.corps);
  assert(!JSON.stringify(b.boite.actions.map((a) => String(a.contenu))).includes(COFFRE), "la valeur du coffre ne part nulle part");
  assert(!JSON.stringify(b.journal).includes(COFFRE), "ni au journal");
  assert(b.journal.some((l) => l.niveau === "warn" && l.champs?.piece === "fuite.txt"), "refus journalisé");
});

await cas(".env refusé", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, ".env"), "A=1"));
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(!m.pieces && piecesDeposees(b.boite).length === 0, "rien déposé");
  assert(m.corps.includes("- .env :"), m.corps);
});

await cas("fichier de consignes et msg-*.md refusés", async () => {
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, "CLAUDE.md"), "consignes");
    await fsp.writeFile(path.join(d, "msg-faux.md"), "faux message");
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(piecesDeposees(b.boite).length === 0 && m.corps.includes("- CLAUDE.md :") && m.corps.includes("- msg-faux.md :"), m.corps);
});

await cas("lien symbolique sortant refusé : le fichier visé ne part pas", async () => {
  const dehors = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "dehors-")), "prive.txt");
  await fsp.writeFile(dehors, "contenu hors projet");
  let lienPossible = true;
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, "ok.txt"), "propre");
    try {
      await fsp.symlink(dehors, path.join(d, "lien.txt"));
    } catch {
      lienPossible = false; // Windows sans droit : le cas ne s'applique pas
    }
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["ok.txt"]), `reçu ${JSON.stringify(m.pieces)}`);
  if (lienPossible) {
    assert(m.corps.includes("- lien.txt :"), m.corps);
    assert(!piecesDeposees(b.boite).some((p) => String(p.contenu).includes("hors projet")), "contenu extérieur absent");
  }
});

await cas("`relais-envoi` lui-même lien vers l'extérieur : aucun dossier créé dehors, tour sans pièce", async () => {
  const dehors = await fsp.mkdtemp(path.join(os.tmpdir(), "dehors-"));
  const b = await posteVeilleur(null);
  try {
    await fsp.symlink(dehors, path.join(b.cwd, "relais-envoi"));
  } catch {
    return; // pas de lien possible ici
  }
  await uneReleve(b.deps);
  assert((await fsp.readdir(dehors)).length === 0, "rien créé hors du projet");
  const m = messageDepose(b.boite);
  assert(!m.pieces && b.journal.some((l) => l.niveau === "warn" && l.message.includes("dossier de sortie non créé")), "dit au journal");
});

await cas("sous-dossier refusé, son contenu ne part pas", async () => {
  const b = await posteVeilleur(async (d) => {
    await fsp.mkdir(path.join(d, "sous"));
    await fsp.writeFile(path.join(d, "sous", "dedans.txt"), "caché");
    await fsp.writeFile(path.join(d, "plat.txt"), "à plat");
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["plat.txt"]), `reçu ${JSON.stringify(m.pieces)}`);
  assert(m.corps.includes("- sous :"), m.corps);
});

await cas("21e fichier refusé : 20 partent", async () => {
  const b = await posteVeilleur(async (d) => {
    for (let i = 1; i <= 21; i++) await fsp.writeFile(path.join(d, `f${String(i).padStart(2, "0")}.txt`), `n${i}`);
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(m.pieces.length === 20 && !m.pieces.includes("f21.txt"), `${m.pieces.length} pièces`);
  assert(m.corps.includes("- f21.txt : au-delà de 20 fichiers"), m.corps);
});

await cas("dossier absent ou vide : aucune pièce, aucun bruit", async () => {
  const b = await posteVeilleur(async (_d, cwd) => fsp.rm(path.join(cwd, "relais-envoi"), { recursive: true }));
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(!m.pieces && m.corps === "fait", `corps intact (reçu ${JSON.stringify(m.corps)})`);
  const v = await posteVeilleur(async () => {});
  await uneReleve(v.deps);
  assert(!messageDepose(v.boite).pieces && messageDepose(v.boite).corps === "fait", "dossier vide");
  assert(b.journal.concat(v.journal).every((l) => l.niveau !== "warn"), "aucun avertissement");
});

await cas("réponse retenue pour secret dans le corps : AUCUNE pièce ne part", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "ok.txt"), "propre"), { corps: `voici la clé ${COFFRE}`, coutUsd: 0.1 });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(m.corps.startsWith("Réponse retenue") && !m.corps.includes(COFFRE), m.corps);
  assert(piecesDeposees(b.boite).length === 0 && !m.pieces, "zéro pièce");
  assert(b.compte.collectes === 0, "même pas collectées");
  assert(!(await existe(path.join(b.cwd, "relais-envoi", dossierDe("m1")))), "dossier tout de même retiré");
});

await cas("tour interrompu : aucune pièce", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "ok.txt"), "propre"), { corps: "Délai dépassé, tour interrompu.", coutUsd: 0.1, interrompu: true });
  await uneReleve(b.deps);
  assert(piecesDeposees(b.boite).length === 0 && !messageDepose(b.boite).pieces, "zéro pièce");
});

await cas("demande refusée (info) : pas de dossier, pas de pièce", async () => {
  const b = await posteVeilleur(async () => {});
  b.boite.actions.length = 0;
  const trop = serialiserMessage({ fil: "f1", id: "m9", type: "demande", profondeur: 99, corps: "boucle" });
  const boite = fausseBoite({ "msg-m9.md": { de: "maison", contenu: trop } });
  await uneReleve({ ...b.deps, boite });
  assert(piecesDeposees(boite).length === 0 && !(await existe(path.join(b.cwd, "relais-envoi"))), "rien");
  assert(messageDepose(boite).type === "info", "réponse info");
});

await cas("échec de dépôt d'une pièce : le message part quand même, avec le refus", async () => {
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, "bonne.txt"), "ok");
    await fsp.writeFile(path.join(d, "mauvaise.txt"), "ko");
  });
  b.boite.echecPiece.add("mauvaise.txt");
  const bilan = await uneReleve(b.deps);
  assert(bilan.traites.length === 1, "traitée");
  const m = messageDepose(b.boite);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["bonne.txt"]), `reçu ${JSON.stringify(m.pieces)}`);
  assert(m.corps.includes("- mauvaise.txt : dépôt impossible"), m.corps);
  assert(b.journal.some((l) => l.niveau === "warn" && l.champs?.piece === "mauvaise.txt"), "journalisé");
});

await cas("reprise après plantage : message redéposé seul, sans re-collecte ni contenu en état", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "rapport.txt"), "SECRET-DE-PIECE-CONTENU"));
  b.boite.echecMessage = 1; // le dépôt du message échoue, comme un plantage juste avant
  await uneReleve(b.deps);
  const attente = b.etat.entrees.get("m1").reponse;
  assert(attente && !JSON.stringify(attente).includes("SECRET-DE-PIECE-CONTENU"), "contenu des pièces absent de l'état");
  assert(lireMessage(attente.contenu).message.pieces?.[0] === "rapport.txt", "l'en-tête garde les noms déposés");
  assert(piecesDeposees(b.boite).length === 1 && b.compte.collectes === 1, "pièce déjà partie, collectée une fois");
  assert(await existe(path.join(b.cwd, "relais-envoi", dossierDe("m1"))), "dossier gardé tant que le message n'est pas parti");
  const bilan = await uneReleve(b.deps);
  assert(bilan.repris?.includes("m1"), "reprise");
  assert(piecesDeposees(b.boite).length === 1 && b.compte.collectes === 1, "ni re-dépôt de pièce ni re-collecte");
  const m = messageDepose(b.boite);
  assert(m.pieces?.[0] === "rapport.txt", "message redéposé avec ses pièces");
  assert(!(await existe(path.join(b.cwd, "relais-envoi", dossierDe("m1")))), "dossier supprimé après la reprise");
});

await cas("suppression du dossier en échec : ligne warn, jamais d'erreur", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "a.txt"), "a"), undefined, {
    supprimerSortie: async () => {
      throw new Error("verrou");
    },
  });
  const bilan = await uneReleve(b.deps);
  assert(bilan.traites.length === 1 && !bilan.erreur, "relève sans erreur");
  assert(b.journal.some((l) => l.niveau === "warn" && l.message.includes("dossier de sortie non supprimé")), "dit au journal");
});

await cas("collecte : taille cumulée et fichier trop gros refusés sans lecture complète", async () => {
  const b = await posteVeilleur(null);
  await preparerSortie(b.cwd, "m7");
  const d = path.join(b.cwd, "relais-envoi", dossierDe("m7"));
  const gros = await fsp.open(path.join(d, "gros.bin"), "w");
  await gros.truncate(201 * 1024 * 1024); // fichier creux : 201 Mo
  await gros.close();
  await fsp.writeFile(path.join(d, "petit.txt"), "p");
  const r = await collecterSortie(b.cwd, "m7", []);
  assert(r.pieces.length === 1 && r.pieces[0].nom === "petit.txt", `pièces ${r.pieces.map((p) => p.nom)}`);
  assert(r.refusees.length === 1 && r.refusees[0].nom === "gros.bin", `refus ${JSON.stringify(r.refusees)}`);
});


// ───────────────────────── Relecture adverse de T-230 ─────────────────────────

/** Fabrique un ZIP (entrées vides, méthode « stockée ») ; `prefixe` : octets placés devant l'archive. */
function fabriquerZip(entrees, { prefixe = Buffer.alloc(0), flags = 0, coupe = false } = {}) {
  const locaux = [];
  const centraux = [];
  let decalage = 0;
  for (const e of entrees) {
    const nom = Buffer.isBuffer(e.nom) ? e.nom : Buffer.from(e.nom, "utf8");
    const extra = e.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? flags, 6);
    local.writeUInt16LE(nom.length, 26);
    locaux.push(local, nom);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags ?? flags, 8);
    c.writeUInt16LE(nom.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(decalage, 42);
    centraux.push(c, nom, extra);
    decalage += 30 + nom.length;
  }
  const central = Buffer.concat(centraux);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entrees.length, 8);
  eocd.writeUInt16LE(entrees.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(decalage, 16);
  const tout = Buffer.concat([prefixe, ...locaux, central, eocd]);
  return coupe ? tout.subarray(0, tout.length - 30) : tout;
}

/** Collecte directe d'un dossier de sortie garni de `fichiers` { nom: Buffer|string }. */
async function collecterDe(fichiers, connus = [COFFRE]) {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-collecte-")));
  await preparerSortie(cwd, "d1");
  for (const [nom, c] of Object.entries(fichiers)) await fsp.writeFile(path.join(cwd, "relais-envoi", dossierDe("d1"), nom), c);
  return collecterSortie(cwd, "d1", connus);
}
const refuse = (r, nom) => r.refusees.find((x) => x.nom === nom);

await cas("archive ZIP : une entrée sensible, de consignes, sous .git/.iaction, réglage ou msg-*.md fait refuser TOUTE l'archive", async () => {
  const noms = [".env", "projet/.ssh/id_rsa", "CLAUDE.md", "sous/AGENTS.md", ".mcp.json", "x/.git/config", "a/.IACTION/veilleur.json", ".claude/settings.local.json", "msg-faux.md", "../evasion.txt", "\\\\serveur\\x", "ok.txt\0.env"];
  const fichiers = { "propre.zip": fabriquerZip([{ nom: "a.txt" }, { nom: "dossier/b.txt" }]) };
  noms.forEach((n, i) => (fichiers[`mauvaise${i}.zip`] = fabriquerZip([{ nom: "a.txt" }, { nom: n }])));
  const r = await collecterDe(fichiers);
  assert(r.pieces.length === 1 && r.pieces[0].nom === "propre.zip", `seule l'archive propre part (reçu ${r.pieces.map((p) => p.nom)})`);
  for (let i = 0; i < noms.length; i++) assert(refuse(r, `mauvaise${i}.zip`), `archive refusée pour l'entrée ${JSON.stringify(noms[i])}`);
});

await cas("archive ZIP : .docx ordinaire accepté ; polyglotte (octets devant), nom « Unicode Path » et nom latin1 trompeurs refusés", async () => {
  const unicode = Buffer.concat([Buffer.from([0x75, 0x70, 0x09, 0x00, 1, 0, 0, 0, 0]), Buffer.from(".env")]);
  const r = await collecterDe({
    "rapport.docx": fabriquerZip([{ nom: "[Content_Types].xml" }, { nom: "word/document.xml" }]),
    "image.png": fabriquerZip([{ nom: ".env" }], { prefixe: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
    "double.zip": fabriquerZip([{ nom: "innocent.txt", extra: unicode }]),
  });
  assert(r.pieces.length === 1 && r.pieces[0].nom === "rapport.docx", `reçu ${r.pieces.map((p) => p.nom)}`);
  assert(refuse(r, "image.png") && refuse(r, "double.zip"), "polyglotte et nom caché refusés");
});

await cas("archive ZIP chiffrée, tronquée ou incohérente : refusée", async () => {
  const r = await collecterDe({
    "chiffre.zip": fabriquerZip([{ nom: "a.txt", flags: 1 }]),
    "tronque.zip": fabriquerZip([{ nom: "a.txt" }, { nom: "b.txt" }], { coupe: true }),
    "cassee.zip": Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(40)]),
  });
  assert(r.pieces.length === 0, `rien ne part (reçu ${r.pieces.map((p) => p.nom)})`);
  assert(refuse(r, "chiffre.zip").raison.includes("chiffrée") && refuse(r, "tronque.zip") && refuse(r, "cassee.zip"), JSON.stringify(r.refusees));
});

await cas("autres conteneurs (gzip, 7z, rar, xz, zstd, bz2, tar) refusés : « envoyer un .zip » ; un fichier ordinaire passe", async () => {
  const tar = Buffer.alloc(512);
  tar.write("ustar", 257);
  const r = await collecterDe({
    "a.gz": Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]),
    "b.7z": Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
    "c.rar": Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0]),
    "d.xz": Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0]),
    "e.zst": Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]),
    "f.bz2": Buffer.from("BZh91AY&SY"),
    "g.tar": tar,
    "h.txt": "BZ n'est pas une archive",
    "sans-extension": Buffer.from([0x1f, 0x8b, 8, 0]),
  });
  assert(r.pieces.length === 1 && r.pieces[0].nom === "h.txt", `reçu ${r.pieces.map((p) => p.nom)}`);
  for (const n of ["a.gz", "b.7z", "c.rar", "d.xz", "e.zst", "f.bz2", "g.tar", "sans-extension"]) assert(refuse(r, n)?.raison.includes("envoyer un .zip"), `${n} : ${refuse(r, n)?.raison}`);
});

await cas("valeur du coffre écrite en UTF-16 (LE, BE, avec ou sans marque) : détectée ; fenêtre de 1 Mo : un motif à cheval est vu", async () => {
  const le = Buffer.from(`clé=${COFFRE}`, "utf16le");
  const be = Buffer.from(le).swap16();
  assert(motifSecretDansContenu(le, [COFFRE]) && motifSecretDansContenu(be, [COFFRE]), "UTF-16 LE et BE");
  assert(motifSecretDansContenu(Buffer.concat([Buffer.from([0xff, 0xfe]), le]), [COFFRE]), "avec marque d'ordre");
  assert(motifSecretDansContenu(Buffer.from("propre", "utf16le"), [COFFRE]) === null, "UTF-16 propre : rien");
  const cle = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----");
  for (const decalage of [(1 << 20) - 10, (1 << 20) - 1, (1 << 20) + 3]) {
    const gros = Buffer.alloc((1 << 20) + 2048, 0x61);
    cle.copy(gros, decalage);
    assert(motifSecretDansContenu(gros, []) === "une clé privée", `motif à cheval en ${decalage}`);
  }
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("-----BEGIN RSA PRIVATE KEY-----", "utf16le")]);
  assert(motifSecretDansContenu(bom, []) === "une clé privée", "clé privée en UTF-16 avec marque");
  const r = await collecterDe({ "note.txt": le, "propre.txt": "rien" });
  assert(r.pieces.length === 1 && refuse(r, "note.txt"), "la collecte refuse la pièce en UTF-16");
});

await cas("nom de pièce porteur d'un secret : refusé, jamais cité (corps, en-tête, nom en boîte, journal, état)", async () => {
  const nomSecret = `${COFFRE}.txt`;
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, nomSecret), "contenu banal");
    await fsp.writeFile(path.join(d, "ok.txt"), "propre");
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["ok.txt"]), `reçu ${JSON.stringify(m.pieces)}`);
  assert(m.corps.includes("(nom retenu)"), m.corps);
  const tout = JSON.stringify([b.boite.actions.map((a) => [a.nom, String(a.contenu)]), b.journal, [...b.etat.entrees.values()]]);
  assert(!tout.includes(COFFRE), "la valeur du coffre n'apparaît nulle part");
});

await cas("échec de dépôt d'une pièce : le texte qui part n'a que le code d'erreur, jamais le chemin ; le détail va au journal", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "x.bin"), "x"));
  b.boite.echecPiece.add("x.bin");
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(m.corps.includes("dépôt impossible (EBUSY)"), m.corps);
  assert(!m.corps.includes("/srv/prive") && !JSON.stringify(b.boite.actions).includes("chemin-du-poste"), "aucun chemin ne part");
  assert(b.journal.some((l) => String(l.champs?.detail).includes("chemin-du-poste")), "détail complet au journal local");
});

await cas("collecte en échec : le corps n'a que le code, le détail est au journal", async () => {
  const b = await posteVeilleur(async () => {}, undefined, {
    collecterSortie: async () => {
      throw Object.assign(new Error("EACCES: permission denied, scandir '/poste/projet/relais-envoi'"), { code: "EACCES" });
    },
  });
  await uneReleve(b.deps);
  const m = messageDepose(b.boite);
  assert(m.corps.includes("collecte impossible (EACCES)") && !m.corps.includes("/poste/"), m.corps);
  assert(b.journal.some((l) => String(l.champs?.detail).includes("/poste/projet")), "détail au journal");
});

await cas("arrêt pendant l'envoi (écriture de la confirmation en échec) : reprise = MÊME id, seules les pièces confirmées annoncées, manquantes dites", async () => {
  const b = await posteVeilleur(async (d) => {
    await fsp.writeFile(path.join(d, "a.txt"), "a");
    await fsp.writeFile(path.join(d, "b.txt"), "b");
  });
  b.etat.echecAuAppel = 3; // 1 = message préparé, 2 = a confirmée, 3 = b confirmée (le « plantage »)
  const premiere = await uneReleve(b.deps);
  assert(premiere.erreur, "la première relève s'arrête sur l'état");
  const deposees = piecesDeposees(b.boite);
  assert(deposees.length === 2 && b.boite.actions.every((a) => a.type !== "deposer"), "deux pièces parties, pas de message");
  const idReponse = deposees[0].nom.replace(/-a\.txt$/, "");
  const attente = b.etat.entrees.get("m1").reponse;
  assert(attente.pieces.prevues.length === 2 && attente.pieces.confirmees.length === 1, `état : ${JSON.stringify(attente.pieces)}`);
  b.etat.echecAuAppel = 0;
  const seconde = await uneReleve(b.deps);
  assert(seconde.repris?.includes("m1"), "reprise");
  const m = messageDepose(b.boite);
  assert(m.id === idReponse, `même id que les pièces (${m.id} / ${idReponse})`);
  assert(JSON.stringify(m.pieces) === JSON.stringify(["a.txt"]), `annonce seulement a.txt (reçu ${JSON.stringify(m.pieces)})`);
  assert(m.corps.includes("Pièces non confirmées") && m.corps.includes("- b.txt :"), m.corps);
  assert(piecesDeposees(b.boite).length === 2, "aucune pièce redéposée");
  assert(!(await existe(path.join(b.cwd, "relais-envoi", dossierDe("m1")))), "dossier supprimé seulement après le message");
});

await cas("état d'avant T-230 (réponse sans pièces) relu ; pièces relues et conservées sur disque", async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-etat-"));
  const chemin = path.join(d, "etat.json");
  const etat = creerEtatFichier(chemin);
  await etat.marquerEnCours({ id: "x1", nom: "msg-x1.md", de: "maison", fil: "f", profondeur: 0 });
  await etat.preparerReponse("x1", { dest: "maison", nom: "msg-r.md", contenu: "c" });
  assert(!("pieces" in (await creerEtatFichier(chemin).enCours())[0].reponse), "ancien format : pas de champ pièces");
  await etat.preparerReponse("x1", { dest: "maison", nom: "msg-r.md", contenu: "c", pieces: { prevues: ["a", "b"], confirmees: ["a"] } });
  const relu = (await creerEtatFichier(chemin).enCours())[0].reponse;
  assert(JSON.stringify(relu.pieces) === JSON.stringify({ prevues: ["a", "b"], confirmees: ["a"] }), JSON.stringify(relu));
});

await cas("segmentSur : noms réservés de Windows (toute casse) et point final refusés", async () => {
  for (const n of ["CON", "con", "Nul", "PRN", "aux", "COM1", "lpt9", "con.txt", "NUL.tar.gz", "fil.", "a.b."]) assert(!segmentSur(n), `${n} refusé`);
  for (const n of ["console", "com10", "commit", "f1", "7c1e-4b09_ab.1", "lpt0"]) assert(segmentSur(n), `${n} accepté`);
  const lu = lireMessage(serialiserMessage({ fil: "CON", id: "m1", type: "demande", profondeur: 0, corps: "x" }));
  assert("invalide" in lu, "un fil « CON » rend le message invalide");
});

await cas("dossier de sortie par empreinte : deux ids qui ne diffèrent que par la casse n'en partagent pas ; reliquat nettoyé", async () => {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-casse-")));
  const a = await preparerSortie(cwd, "Abc");
  const b = await preparerSortie(cwd, "abc");
  assert(a !== b && a === a.toLowerCase() && !a.includes("Abc"), `chemins ${a} / ${b}`);
  await fsp.writeFile(path.join(cwd, a, "reste.txt"), "reliquat d'un plantage");
  await preparerSortie(cwd, "Abc");
  assert((await fsp.readdir(path.join(cwd, a))).length === 0, "reliquat retiré, dossier vide");
  assert(await existe(path.join(cwd, b)), "l'autre dossier est intact");
});

await cas("reliquats : dossier d'une demande répondue ou trop vieux retiré, celui d'une demande en cours gardé", async () => {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-reliquats-")));
  const chemins = {};
  for (const id of ["rep", "cours", "vieux"]) chemins[id] = path.join(cwd, await preparerSortie(cwd, id));
  const ancien = new Date(Date.now() - 9 * 24 * 3600 * 1000);
  await fsp.utimes(chemins.vieux, ancien, ancien);
  const bilan = await nettoyerSorties(cwd, ["rep"], 8 * 24 * 3600 * 1000);
  assert(bilan.retires === 2 && bilan.echecs.length === 0, JSON.stringify(bilan));
  assert(!(await existe(chemins.rep)) && !(await existe(chemins.vieux)) && (await existe(chemins.cours)), "répondu et vieux partis, en cours gardé");
  assert((await nettoyerSorties(cwd, [], 1000)).retires === 0, "rien à retirer : rien");
});

await cas("suppression en échec : retentée à chaque relève (dossier retiré dès que possible), dite UNE fois", async () => {
  const b = await posteVeilleur(async (d) => fsp.writeFile(path.join(d, "a.txt"), "a"), undefined, {
    supprimerSortie: async () => {
      throw new Error("verrou");
    },
    dejaSignales: new Set(),
  });
  await uneReleve(b.deps);
  const dossier = path.join(b.cwd, "relais-envoi", dossierDe("m1"));
  assert(await existe(dossier), "dossier resté");
  // Le nettoyage de reliquats est branché sur un échec persistant, puis sur le vrai : deux relèves.
  const echecs = [{ nom: dossierDe("m1"), cause: "EBUSY" }];
  let appels = 0;
  const deps = { ...b.deps, nettoyerSorties: async () => ((appels += 1), { retires: 0, echecs }) };
  await uneReleve(deps);
  await uneReleve(deps);
  assert(appels === 2, "retenté à chaque relève");
  assert(b.journal.filter((l) => l.message.includes("nouvel essai à chaque relève")).length === 1, "dit une seule fois");
  const reel = { ...b.deps, nettoyerSorties: (r) => nettoyerSorties(b.cwd, r, 8 * 24 * 3600 * 1000) };
  await uneReleve(reel);
  assert(!(await existe(dossier)), "retiré par la relève suivante");
});

await cas("cumul : deux fichiers de 120 Mo ne passent pas ensemble (200 Mo cumulés au plus)", async () => {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-cumul-")));
  await preparerSortie(cwd, "c1");
  const d = path.join(cwd, "relais-envoi", dossierDe("c1"));
  for (const n of ["a.bin", "b.bin"]) {
    const h = await fsp.open(path.join(d, n), "w");
    await h.truncate(120 * 1024 * 1024);
    await h.close();
  }
  const r = await collecterSortie(cwd, "c1", []);
  assert(r.pieces.length === 1 && r.refusees.length === 1 && r.refusees[0].raison.includes("cumulés"), JSON.stringify(r.refusees));
});

console.log(`veilleurSortie : ${ok} cas OK`);
