/*
 * Méthodes `veilleur.*` contre un VRAI sidecar (veilleurProtocole.ts), la
 * coquille simulée par le test (coffre.charger, accusés coffre.ecrit) :
 * configurer = approuver (refusé coffre fermé, scellé par projet sinon), lire
 * (approuvée ou non), activer (refusé sur une config réécrite ; actif:true
 * re-scellé ; événement `veilleur` sans id), désactiver (actif:false re-scellé,
 * scellé gardé, poste oublié), oublier (config et scellé supprimés). Aucun
 * jeton au coffre : rien ne part sur le réseau.
 *
 * Lancement isolé : node sidecar/test/veilleurProtocole.test.js
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { assert, defaultXdgConfigHome, entry, lancer } from "./harness.mjs";

const config = {
  actif: false,
  expediteurs: ["maison"],
  agent: null,
  compte: "perso",
  modele: "claude-opus-5-5",
  effort: "medium",
  permission: "bypassPermissions",
  bash: true,
  plafonds: { profondeur: 6, coutParMessage: 5, toursParJour: 100, dureeMin: 20 },
  cadenceSec: 30,
  url: "https://relay.example.net",
  jetonSecret: "relais.jeton",
};

async function avecSidecar(corps) {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, IACTION_FAKE_CLAUDE: "1" } });
  const recus = [];
  const attentes = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (ligne) => {
    if (!ligne.trim()) return;
    const evt = JSON.parse(ligne);
    recus.push(evt);
    for (let i = attentes.length - 1; i >= 0; i--) {
      if (attentes[i].p(evt)) {
        clearTimeout(attentes[i].t);
        attentes.splice(i, 1)[0].r(evt);
      }
    }
  });
  const attendre = (p, quoi) =>
    recus.find(p) ??
    new Promise((r, rej) => {
      const a = { p, r };
      a.t = setTimeout(() => rej(new Error(`timeout : ${quoi}`)), 5000);
      attentes.push(a);
    });
  let n = 0;
  const appeler = async (method, params = {}) => {
    const id = `v-${(n += 1)}`;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return attendre((e) => e.id === id && e.event !== "chunk", method);
  };
  try {
    await attendre((e) => e.event === "ready", "ready");
    return await corps({ appeler, attendre, recus });
  } finally {
    child.kill();
  }
}

async function testParcours() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-proto-"));
  await fsp.mkdir(path.join(cwd, ".git", "info"), { recursive: true }); // un dépôt git : l'enregistrement pose l'exclusion locale
  await avecSidecar(async ({ appeler, attendre, recus }) => {
    const absent = await appeler("veilleur.lire", { cwd });
    assert(absent.event === "done" && absent.data.absent === true, "lire : absent");

    const refus = await appeler("veilleur.configurer", { cwd, config: { ...config, permission: "acceptEdits" } });
    assert(refus.event === "error" && refus.data.message.includes("bypassPermissions"), `config invalide refusée (reçu ${JSON.stringify(refus.data)})`);

    const relatif = await appeler("veilleur.configurer", { cwd: "relatif", config });
    assert(relatif.event === "error", "cwd relatif refusé");

    // Coffre absent (pas de coquille) : enregistrer = approuver est impossible, rien n'est écrit.
    const sansCoffre = await appeler("veilleur.configurer", { cwd, config });
    assert(sansCoffre.event === "error" && sansCoffre.data.message.includes("coffre fermé"), `refus coffre fermé (reçu ${JSON.stringify(sansCoffre.data)})`);
    assert((await appeler("veilleur.lire", { cwd })).data.absent === true, "rien d'écrit");

    // Coffre ouvert (comme la coquille le pousse), sans jeton.
    await appeler("coffre.charger", { etat: "ouvert", secrets: {}, nomsCoffre: [] });
    const accuses = new Set();
    // Table du coffre simulée : comme la coquille, on la REPOUSSE (avec la classe) avant l'accusé.
    const table = {};
    const repousser = (noms = Object.keys(table)) => appeler("coffre.charger", { etat: "ouvert", secrets: { ...table }, nomsCoffre: noms });
    /** Prochaine demande d'écriture/retrait adressée à la coquille, accusée aussitôt. */
    const accuser = async (evenement) => {
      const d = await attendre((e) => e.event === evenement && !accuses.has(e.data.demande), evenement);
      accuses.add(d.data.demande);
      if (evenement === "coffre:ecrire") table[d.data.nom] = d.data.valeur;
      else delete table[d.data.nom];
      await repousser();
      await appeler("coffre.ecrit", { demande: d.data.demande, ok: true });
      return d.data;
    };
    const enregistrer = async (c) => {
      const appel = appeler("veilleur.configurer", { cwd, config: c });
      const scelle = await accuser("coffre:ecrire");
      return { reponse: await appel, scelle };
    };

    const { reponse: ecrit, scelle } = await enregistrer(config);
    assert(ecrit.event === "done" && ecrit.data.config.cadenceSec === 30, `config écrite (reçu ${JSON.stringify(ecrit.data)})`);
    assert(/^veilleur\.empreinte\.[0-9a-f]{8}$/.test(scelle.nom) && /^[0-9a-f]{64}$/.test(scelle.valeur), `scellé du projet (reçu ${scelle.nom})`);
    const lu = await appeler("veilleur.lire", { cwd });
    assert(lu.data.config.url === config.url && lu.data.scellee === true, "relue, approuvée");
    const exclude = await fsp.readFile(path.join(cwd, ".git", "info", "exclude"), "utf8");
    assert(exclude.includes("/.iaction/veilleur.json") && exclude.includes("/relais-recu/"), "exclusion git locale posée");

    // Le même scellé, servi par la classe sans-fenetre (pas dans nomsCoffre) ou par une coquille ancienne : NON reconnu.
    await repousser([]);
    assert((await appeler("veilleur.lire", { cwd })).data.scellee === false, "scellé côté sans-fenetre : non reconnu");
    await appeler("coffre.charger", { etat: "ouvert", secrets: { ...table } });
    assert((await appeler("veilleur.lire", { cwd })).data.scellee === false, "coquille ancienne : non reconnu");
    await repousser();

    // Réécrite hors de l'interface : lire le dit (avec les champs changés), activer refuse.
    const fichier = path.join(cwd, ".iaction", "veilleur.json");
    const approuve = await fsp.readFile(fichier, "utf8");
    await fsp.writeFile(fichier, JSON.stringify({ ...config, url: "https://ailleurs.example.net" }));
    const tamper = await appeler("veilleur.lire", { cwd });
    assert(tamper.data.scellee === false && JSON.stringify(tamper.data.differences) === JSON.stringify(["url"]), `lire : non approuvée, champs dits (reçu ${JSON.stringify(tamper.data.differences)})`);
    const refusee = await appeler("veilleur.activer", { cwd });
    assert(refusee.event === "error" && refusee.data.message.includes("modifiée hors de l'interface"), `activation refusée (reçu ${JSON.stringify(refusee.data)})`);
    await fsp.writeFile(fichier, approuve);

    // Activer : ne scelle pas une config étrangère ; pose actif:true et re-scelle ce seul changement.
    const activation = appeler("veilleur.activer", { cwd });
    const rescelle = await accuser("coffre:ecrire");
    assert(rescelle.nom === scelle.nom && rescelle.valeur !== scelle.valeur, "actif:true re-scellé sous le même nom");
    const active = await activation;
    assert(active.event === "done" && active.data.cwd === cwd, `activé (reçu ${JSON.stringify(active.data)})`);
    assert(JSON.parse(await fsp.readFile(fichier, "utf8")).actif === true, "actif:true posé");
    const poste = JSON.parse(await fsp.readFile(path.join(defaultXdgConfigHome, "net.duvam.iaction", "veilleur", "poste.json"), "utf8"));
    assert(poste.cwd === cwd, "poste mémorisé hors projet");

    const pousse = await attendre((e) => e.event === "veilleur" && e.data.etat === "invalide" && e.data.motif.includes("relais.jeton"), "événement veilleur");
    assert(pousse.id === undefined, "événement non sollicité, sans id");
    assert(!pousse.data.motif.includes("hors de l'interface"), "le scellé a été reconnu (seul le jeton manque)");

    // Désactiver : actif:false re-scellé, scellé GARDÉ (pas de retrait).
    const desactivation = appeler("veilleur.desactiver", {});
    const rescelle2 = await accuser("coffre:ecrire");
    assert(rescelle2.nom === scelle.nom, "actif:false re-scellé");
    const fin = await desactivation;
    assert(fin.event === "done" && fin.data.etat === "inactif" && fin.data.avertissement === undefined, `désactivé (reçu ${JSON.stringify(fin.data)})`);
    assert(!recus.some((e) => e.event === "coffre:retirer"), "le scellé n'est pas retiré à la désactivation");
    assert(JSON.parse(await fsp.readFile(fichier, "utf8")).actif === false, "actif:false posé");
    assert((await appeler("veilleur.lire", { cwd })).data.scellee === true, "toujours approuvée pour les outils");
    const posteApres = await fsp.readFile(path.join(defaultXdgConfigHome, "net.duvam.iaction", "veilleur", "poste.json"), "utf8").catch(() => null);
    assert(posteApres === null, "poste oublié : pas de redémarrage au lancement");

    // Désactiver une config NON scellée : rien n'est re-scellé (ce serait l'approuver), c'est dit.
    const ecrituresAvant = recus.filter((e) => e.event === "coffre:ecrire").length;
    await fsp.writeFile(fichier, JSON.stringify({ ...config, actif: true, expediteurs: ["maison", "intrus"] }));
    const sansScelle = await appeler("veilleur.desactiver", {});
    assert(sansScelle.event === "done" && String(sansScelle.data.avertissement).includes("hors de l'interface"), `avertissement (reçu ${JSON.stringify(sansScelle.data)})`);
    await new Promise((r) => setTimeout(r, 50));
    assert(recus.filter((e) => e.event === "coffre:ecrire").length === ecrituresAvant, "aucun re-scellé");
    assert(JSON.parse(await fsp.readFile(fichier, "utf8")).expediteurs.includes("intrus"), "fichier non réécrit");
    assert((await appeler("veilleur.lire", { cwd })).data.scellee === false, "toujours non approuvée");

    // Oublier : config et scellé supprimés.
    const oubli = appeler("veilleur.oublier", { cwd });
    const retrait = await accuser("coffre:retirer");
    assert(retrait.nom === scelle.nom, "scellé du projet retiré");
    const oublie = await oubli;
    assert(oublie.event === "done" && oublie.data.oublie === true, `oublié (reçu ${JSON.stringify(oublie.data)})`);
    assert((await appeler("veilleur.lire", { cwd })).data.absent === true, "config supprimée");
    assert(!JSON.stringify(recus).includes("JETON"), "aucun jeton");
  });
}

await lancer("méthodes veilleur.* du protocole", testParcours);
