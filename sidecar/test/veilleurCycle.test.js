/*
 * Cycle du veilleur (veilleurCycle.ts) — l'ordre sûr, avec des fakes.
 * On vérifie : exécution nominale, dépôt puis suppression, marquage AVANT
 * l'effet de bord, émetteur non écouté ni téléchargé ni exécuté, invalide
 * laissé, refus de profondeur répondu. T-227 : reponse/info jamais exécutées ;
 * une demande ne disparaît jamais sans réponse (réponse gardée et redéposée,
 * tour interrompu signalé, jamais rejoué) ; état en échec = relève en échec ;
 * contenu substitué dans la boîte = rien d'exécuté ; réponse porteuse d'un
 * secret retenue ; coût dépassé ou inconnu après interruption ⇒ suspension ;
 * liste en échec remontée ; pièces jointes ; arrêt.
 *
 * Lancement isolé : node sidecar/test/veilleurCycle.test.js
 */

import { assert, fail, moduleCompile } from "./harness.mjs";

const { uneReleve, estNomMessage, CORPS_INTERROMPU } = await import(moduleCompile("veilleurCycle.js"));
const { serialiserMessage, lireMessage } = await import(moduleCompile("veilleurMessage.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const plafonds = { profondeur: 6, coutParMessage: 5, toursParJour: 100 };

/** fichiers : { nom -> { de, contenu: string|Buffer, deposeLe? } } — taille calculée. */
function fausseBoite(fichiers) {
  const actions = [];
  const lus = [];
  const entree = (nom) => {
    const v = fichiers[nom];
    const octets = Buffer.isBuffer(v.contenu) ? v.contenu : Buffer.from(v.contenu, "utf8");
    return { nom, de: v.de, taille: octets.length, deposeLe: v.deposeLe ?? 1 };
  };
  const b = {
    actions,
    lus,
    /** Appelé après chaque téléchargement (substitution simulée). */
    apresLecture: null,
    async listerRecus() {
      return Object.keys(fichiers).map(entree);
    },
    async telecharger(nom) {
      return (await b.telechargerBrut(nom)).toString("utf8");
    },
    async telechargerBrut(nom) {
      lus.push(nom);
      if (!(nom in fichiers)) throw new Error("introuvable");
      const v = fichiers[nom];
      const octets = Buffer.isBuffer(v.contenu) ? v.contenu : Buffer.from(v.contenu, "utf8");
      b.apresLecture?.(nom, fichiers);
      return octets;
    },
    async deposer(dest, nom, contenu) {
      actions.push({ type: "deposer", dest, nom, contenu });
    },
    async deposerBrut(dest, nom, contenu) {
      actions.push({ type: "deposerBrut", dest, nom, contenu });
    },
    async supprimer(nom) {
      actions.push({ type: "supprimer", nom });
      delete fichiers[nom];
    },
  };
  return b;
}

/** État en mémoire, même contrat que veilleurEtat.ts ; `casser` fait échouer les écritures. */
function fauxEtat() {
  const entrees = new Map();
  let tours = 0;
  let suspension = null;
  const e = {
    entrees,
    casser: false,
    tours: () => tours,
    ecrire() {
      if (e.casser) throw new Error("disque plein");
    },
    async idsTraites() {
      return [...entrees.keys()];
    },
    async statutDe(id) {
      return entrees.get(id)?.statut ?? null;
    },
    async marquerEnCours(m) {
      e.ecrire();
      if (!entrees.has(m.id)) entrees.set(m.id, { ...m, statut: "en-cours" });
    },
    async preparerReponse(id, r) {
      e.ecrire();
      const x = entrees.get(id);
      if (x && x.statut === "en-cours") x.reponse = r;
    },
    async marquerRepondu(id) {
      e.ecrire();
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
      return tours;
    },
    async incrementerTour() {
      e.ecrire();
      tours += 1;
    },
    async suspension() {
      return suspension;
    },
    async suspendre(motif) {
      suspension = { motif, le: "2026-11-20T10:00:00.000Z" };
    },
    async lever() {
      suspension = null;
    },
  };
  return e;
}

let seq = 0;
const nouvelId = () => `rep${(seq += 1)}`;
const silence = () => {};
const config = { expediteurs: ["maison"], plafonds };

const msg = (over = {}) =>
  serialiserMessage({ fil: "f1", id: "m1", type: "demande", profondeur: 0, corps: "publie", ...over });

await cas("exécution nominale : réponse déposée puis message supprimé", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const etat = fauxEtat();
  const appels = [];
  const lancer = async (m, de) => {
    appels.push({ fil: m.fil, de });
    return { corps: "site publié, CI verte", coutUsd: 0.2 };
  };
  const bilan = await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId });
  assert(bilan.traites.length === 1 && bilan.traites[0] === "m1", "m1 traité");
  assert(appels.length === 1, "tour lancé une fois");
  const ordre = boite.actions.map((a) => a.type);
  assert(ordre.join(",") === "deposer,supprimer", `dépôt puis suppression (reçu ${ordre})`);
  const depot = boite.actions.find((a) => a.type === "deposer");
  assert(depot.dest === "maison", "réponse chez maison");
  const rep = lireMessage(depot.contenu);
  assert("message" in rep && rep.message.type === "reponse", "réponse de type reponse");
  assert(rep.message.enReponseA === "m1", "en réponse à m1");
  assert(rep.message.profondeur === 1, "profondeur incrémentée");
  assert((await etat.statutDe("m1")) === "repondu", "m1 répondu");
  assert(etat.tours() === 1, "un tour compté");
});

await cas("marquage AVANT l'effet de bord : traité même si le tour lève", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const etat = fauxEtat();
  const lancer = async () => {
    assert((await etat.statutDe("m1")) === "en-cours", "marqué avant le tour");
    throw new Error("tour planté");
  };
  const bilan = await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId });
  assert(bilan.traites.length === 0, "pas compté comme réussi");
  assert((await etat.statutDe("m1")) === "en-cours", "m1 reste marqué (jamais rejoué)");
  assert(boite.actions.every((a) => a.type !== "supprimer"), "message non supprimé (pas de réponse)");
});

await cas("émetteur non écouté : ni téléchargé, ni exécuté, laissé ; journal une fois par nom", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "pirate", contenu: msg() } });
  const etat = fauxEtat();
  const lignes = [];
  let lance = false;
  const deps = { boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: (n, m) => lignes.push(m), config, nouvelId, dejaSignales: new Set() };
  const bilan = await uneReleve(deps);
  await uneReleve(deps);
  assert(!lance, "aucun tour");
  assert(boite.lus.length === 0, `rien téléchargé (reçu ${boite.lus})`);
  assert(bilan.ignores.includes("msg-m1.md"), "ignoré");
  assert(boite.actions.length === 0, "rien déposé ni supprimé");
  assert(lignes.filter((l) => l.includes("non écouté")).length === 1, "journal une seule fois");
});

await cas("déjà répondu : reliquat retiré, pas ré-exécuté", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const etat = fauxEtat();
  etat.entrees.set("m1", { id: "m1", statut: "repondu" });
  let lance = false;
  await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId });
  assert(!lance, "aucun tour");
  assert(boite.actions.some((a) => a.type === "supprimer" && a.nom === "msg-m1.md"), "reliquat supprimé");
});

await cas("message invalide (dont fil __proto__) : laissé en boîte", async () => {
  const boite = fausseBoite({
    "msg-x.md": { de: "maison", contenu: "pas un en-tête" },
    "msg-p.md": { de: "maison", contenu: msg({ fil: "__proto__", id: "p" }) },
  });
  const bilan = await uneReleve({ boite, lancer: async () => ({ corps: "x", coutUsd: 0 }), etat: fauxEtat(), journal: silence, config, nouvelId });
  assert(bilan.invalides.includes("msg-x.md") && bilan.invalides.includes("msg-p.md"), `invalides (reçu ${bilan.invalides})`);
  assert(boite.actions.length === 0, "non supprimés");
});

await cas("profondeur au plafond : refus répondu, message retiré", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg({ profondeur: 6 }) } });
  const etat = fauxEtat();
  let lance = false;
  const bilan = await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId });
  assert(!lance, "pas de tour au plafond");
  assert(bilan.refuses.includes("m1"), "refusé");
  const depot = boite.actions.find((a) => a.type === "deposer");
  assert(depot && lireMessage(depot.contenu).message.type === "info", "réponse info de refus");
  assert(boite.actions.some((a) => a.type === "supprimer"), "message retiré");
  assert((await etat.statutDe("m1")) === "repondu", "répondu");
});

await cas("dépôt qui échoue : réponse gardée, redéposée à la relève SUIVANTE, jamais de tour rejoué ni de suppression sans réponse", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const deposerReel = boite.deposer;
  boite.deposer = async () => {
    throw new Error("broker injoignable");
  };
  const etat = fauxEtat();
  let appels = 0;
  const lancer = async () => ((appels += 1), { corps: "fait", coutUsd: 0.1 });
  await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId });
  assert(appels === 1, "tour lancé une fois");
  assert((await etat.enCours())[0]?.reponse, "réponse gardée dans l'état");
  // Relève suivante, broker toujours en panne : ni tour, ni suppression.
  await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId });
  assert(appels === 1, "pas de ré-exécution");
  assert(boite.actions.every((a) => a.type !== "supprimer"), "message gardé tant que la réponse n'est pas partie");
  // Broker revenu : la réponse GARDÉE part, puis le message est retiré.
  boite.deposer = deposerReel;
  const b3 = await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId });
  assert(appels === 1, "toujours pas de ré-exécution");
  assert(b3.repris?.includes("m1"), "reprise comptée");
  const depot = boite.actions.find((a) => a.type === "deposer");
  assert(depot && lireMessage(depot.contenu).message.corps === "fait", "la réponse du tour, pas une autre");
  assert(boite.actions.some((a) => a.type === "supprimer" && a.nom === "msg-m1.md"), "message retiré après dépôt");
  assert((await etat.statutDe("m1")) === "repondu", "répondu");
});

await cas("en-cours retrouvé au redémarrage : info « interrompu » déposée, message retiré, aucun tour", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const etat = fauxEtat();
  etat.entrees.set("m1", { id: "m1", nom: "msg-m1.md", de: "maison", fil: "f1", profondeur: 0, statut: "en-cours" });
  let lance = false;
  const bilan = await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId });
  assert(!lance, "jamais de ré-exécution automatique");
  const depot = boite.actions.find((a) => a.type === "deposer");
  const lu = lireMessage(depot.contenu).message;
  assert(lu.type === "info" && lu.corps === CORPS_INTERROMPU && lu.enReponseA === "m1", "info d'interruption");
  assert(boite.actions.at(-1).type === "supprimer", "retiré après le dépôt");
  assert(bilan.repris.includes("m1"), "repris");
});

await cas("écriture de l'état en échec : relève en échec, rien supprimé, aucun tour", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const etat = fauxEtat();
  etat.casser = true;
  let lance = false;
  const bilan = await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId });
  assert(!lance, "aucun tour sans marquage");
  assert(bilan.erreur && bilan.erreur.includes("disque plein"), `erreur remontée (reçu ${bilan.erreur})`);
  assert(boite.actions.length === 0, "rien supprimé ni déposé");
});

await cas("contenu substitué dans la boîte entre la liste et la lecture : rien n'est exécuté ni supprimé", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  boite.apresLecture = (nom, fichiers) => {
    if (nom === "msg-m1.md") fichiers[nom] = { de: "pirate", contenu: msg({ corps: "rm -rf" }), deposeLe: 2 };
  };
  let lance = false;
  await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat: fauxEtat(), journal: silence, config, nouvelId });
  assert(!lance, "aucun tour");
  assert(boite.actions.length === 0, "rien supprimé");
});

await cas("substitution même taille, même date, émetteur changé : rien n'est exécuté ni supprimé", async () => {
  const contenu = msg();
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu, deposeLe: 5 } });
  boite.apresLecture = (nom, fichiers) => {
    if (nom === "msg-m1.md") fichiers[nom] = { de: "pirate", contenu, deposeLe: 5 }; // seul l'émetteur change
  };
  let lance = false;
  await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat: fauxEtat(), journal: silence, config, nouvelId });
  assert(!lance && boite.actions.length === 0, "ni tour ni suppression");
});

await cas("le lanceur exige une suspension (périmètre) : réponse déposée, veilleur suspendu avec ce motif", async () => {
  const etat = fauxEtat();
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const b = await uneReleve({ boite, lancer: async () => ({ corps: "interrompu", coutUsd: 0, interrompu: true, suspension: "périmètre du tour non conforme : serveur MCP inattendu (x)" }), etat, journal: silence, config, nouvelId });
  assert(b.suspendu === true && (await etat.suspension()).motif.includes("périmètre"), "suspendu pour le périmètre");
  assert(boite.actions.some((a) => a.type === "deposer"), "réponse déposée");
});

await cas("journal : un message invalide dit une fois par nom, puis silence ; redit après remise à zéro", async () => {
  const boite = fausseBoite({ "msg-x.md": { de: "maison", contenu: "pas un en-tête" } });
  const lignes = [];
  const dejaSignales = new Set();
  const deps = { boite, lancer: async () => ({ corps: "x", coutUsd: 0 }), etat: fauxEtat(), journal: (n, m) => lignes.push(m), config, nouvelId, dejaSignales };
  await uneReleve(deps);
  await uneReleve(deps);
  assert(lignes.filter((l) => l.includes("invalide")).length === 1, "une fois");
  dejaSignales.clear(); // changement d'état du service
  await uneReleve(deps);
  assert(lignes.filter((l) => l.includes("invalide")).length === 2, "redit après changement d'état");
});

await cas("pièce substituée : rien n'est exécuté ni marqué", async () => {
  const boite = fausseBoite({
    "msg-m1.md": { de: "maison", contenu: msg({ pieces: ["x.txt"] }) },
    "m1-x.txt": { de: "maison", contenu: Buffer.from("sain") },
  });
  boite.apresLecture = (nom, fichiers) => {
    if (nom === "m1-x.txt") fichiers[nom] = { de: "maison", contenu: Buffer.from("piège plus long"), deposeLe: 9 };
  };
  const etat = fauxEtat();
  let lance = false;
  await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId, recevoirPiece: async () => ({ chemin: "x" }) });
  assert(!lance && (await etat.statutDe("m1")) === null, "ni tour ni marquage");
  assert(boite.actions.length === 0, "rien supprimé");
});

await cas("reponse ou info reçue : laissée en boîte, non marquée, ignorée, journalisée une fois", async () => {
  for (const type of ["reponse", "info"]) {
    const id = `r-${type}`;
    const boite = fausseBoite({ [`msg-${id}.md`]: { de: "maison", contenu: msg({ id, type }) } });
    const etat = fauxEtat();
    const lignes = [];
    const journal = (niveau, message) => lignes.push({ niveau, message });
    let lance = false;
    const deps = { boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: null }), etat, journal, config, nouvelId, dejaSignales: new Set() };
    const b1 = await uneReleve(deps);
    const b2 = await uneReleve(deps);
    assert(!lance, `${type} : aucun tour`);
    assert(b1.ignores.includes(id) && b2.ignores.includes(id), `${type} : ignoré à chaque relève`);
    assert(boite.actions.length === 0, `${type} : ni dépôt ni suppression`);
    assert((await etat.statutDe(id)) === null, `${type} : non marqué`);
    const dits = lignes.filter((l) => l.message.includes("seules les demandes"));
    assert(dits.length === 1, `${type} : journalisé une seule fois (reçu ${dits.length})`);
  }
});

await cas("pièces : écrites avant le tour, retirées de la boîte, manquante signalée", async () => {
  const boite = fausseBoite({
    "msg-m1.md": { de: "maison", contenu: msg({ pieces: ["rapport.json", "absente.txt"] }) },
    "m1-rapport.json": { de: "maison", contenu: Buffer.from("données") },
  });
  const etat = fauxEtat();
  const ecrites = [];
  const recevoirPiece = async (fil, nom, c) => {
    assert((await etat.statutDe("m1")) === "en-cours", "marqué avant l'écriture des pièces");
    ecrites.push({ fil, nom, texte: c.toString() });
    return { chemin: `relais-recu/${fil}/${nom}` };
  };
  let vu;
  const lancer = async (_m, _de, ctx) => ((vu = ctx.pieces), { corps: "ok", coutUsd: 0.1 });
  await uneReleve({ boite, lancer, etat, journal: silence, config, nouvelId, recevoirPiece });
  assert(ecrites.length === 1 && ecrites[0].fil === "f1" && ecrites[0].texte === "données", "pièce écrite dans le fil");
  assert(vu.ecrites[0] === "relais-recu/f1/rapport.json", "pièce reçue dite au lanceur");
  assert(vu.refusees.length === 1 && vu.refusees[0].nom === "absente.txt", "pièce manquante signalée");
  assert(boite.actions.some((a) => a.type === "supprimer" && a.nom === "m1-rapport.json"), "pièce retirée de la boîte");
});

await cas("pièce d'un autre émetteur : ignorée (absente pour ce message)", async () => {
  const boite = fausseBoite({
    "msg-m1.md": { de: "maison", contenu: msg({ pieces: ["x.txt"] }) },
    "m1-x.txt": { de: "pirate", contenu: Buffer.from("piège") },
  });
  let ecrit = false;
  let vu;
  await uneReleve({
    boite,
    lancer: async (_m, _de, ctx) => ((vu = ctx.pieces), { corps: "ok", coutUsd: 0 }),
    etat: fauxEtat(),
    journal: silence,
    config,
    nouvelId,
    recevoirPiece: async () => ((ecrit = true), { chemin: "x" }),
  });
  assert(!ecrit, "rien écrit");
  assert(vu.refusees.length === 1, "signalée non reçue");
});

await cas("réponse portant une valeur du coffre : retenue, journal warn", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const lignes = [];
  await uneReleve({
    boite,
    lancer: async () => ({ corps: "voici le jeton : VALEUR-DU-COFFRE-123456", coutUsd: 0.1 }),
    etat: fauxEtat(),
    journal: (n, m) => lignes.push({ n, m }),
    config,
    nouvelId,
    valeursSecretes: async () => ["VALEUR-DU-COFFRE-123456"],
  });
  const corps = lireMessage(boite.actions.find((a) => a.type === "deposer").contenu).message.corps;
  assert(corps.startsWith("Réponse retenue : elle contenait") && !corps.includes("VALEUR-DU-COFFRE"), corps);
  assert(lignes.some((l) => l.n === "warn" && l.m.includes("retenue")), "journal warn");
});

await cas("coût au-delà du plafond : réponse déposée avec la ligne, puis suspension", async () => {
  const boite = fausseBoite({
    "msg-m1.md": { de: "maison", contenu: msg() },
    "msg-m2.md": { de: "maison", contenu: msg({ id: "m2" }) },
  });
  const etat = fauxEtat();
  let tours = 0;
  const bilan = await uneReleve({ boite, lancer: async () => ((tours += 1), { corps: "fait", coutUsd: 7.5 }), etat, journal: silence, config, nouvelId });
  assert(tours === 1, `un seul tour, le suivant attend (reçu ${tours})`);
  assert(bilan.suspendu === true, "bilan suspendu");
  const corps = lireMessage(boite.actions.find((a) => a.type === "deposer").contenu).message.corps;
  assert(corps.startsWith("fait") && corps.includes("7.50 $") && corps.includes("suspendu"), `ligne finale (reçu ${corps})`);
  assert((await etat.suspension()) !== null, "suspension persistée");
  await uneReleve({ boite, lancer: async () => ((tours += 1), { corps: "x", coutUsd: 0 }), etat, journal: silence, config, nouvelId });
  assert(tours === 1, "aucun tour suspendu");
});

await cas("coût inconnu après interruption, ou arrêt par le moteur au plafond : suspension", async () => {
  for (const issue of [{ corps: "Délai dépassé", coutUsd: null, interrompu: true }, { corps: "Plafond atteint", coutUsd: 4, depassement: true }]) {
    const etat = fauxEtat();
    const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
    const b = await uneReleve({ boite, lancer: async () => issue, etat, journal: silence, config, nouvelId });
    assert(b.suspendu === true && (await etat.suspension()) !== null, `suspendu pour ${issue.corps}`);
  }
});

await cas("coût sous le plafond, ou inconnu sans interruption : pas de suspension", async () => {
  for (const coutUsd of [4.99, null]) {
    const etat = fauxEtat();
    const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
    await uneReleve({ boite, lancer: async () => ({ corps: "ok", coutUsd }), etat, journal: silence, config, nouvelId });
    assert((await etat.suspension()) === null, `pas suspendu pour ${coutUsd}`);
  }
});

await cas("liste en échec : remontée dans le bilan", async () => {
  const boite = fausseBoite({});
  boite.listerRecus = async () => {
    throw new Error("liste de la boîte : le relais répond 401");
  };
  const b = await uneReleve({ boite, lancer: async () => ({ corps: "x", coutUsd: 0 }), etat: fauxEtat(), journal: silence, config, nouvelId });
  assert(b.erreur && b.erreur.includes("401"), `erreur (reçu ${b.erreur})`);
});

await cas("signal d'arrêt : aucun nouveau message traité", async () => {
  const boite = fausseBoite({ "msg-m1.md": { de: "maison", contenu: msg() } });
  const ctrl = new AbortController();
  ctrl.abort();
  let lance = false;
  await uneReleve({ boite, lancer: async () => ((lance = true), { corps: "x", coutUsd: null }), etat: fauxEtat(), journal: silence, config, nouvelId, signal: ctrl.signal });
  assert(!lance, "rien lancé après l'arrêt");
});

await cas("estNomMessage", async () => {
  assert(estNomMessage("msg-ab12.md"), "msg valide");
  assert(!estNomMessage("rapport.json"), "pièce ignorée");
  assert(!estNomMessage("autre.md"), "sans préfixe msg-");
});

console.log(`veilleurCycle : ${ok} cas OK`);
