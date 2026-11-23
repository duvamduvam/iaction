/*
 * Config du veilleur (veilleurConfig.ts) — validation stricte et lecture,
 * et garde d'écriture (fichiersSecrets).
 *
 * Lancement isolé : node sidecar/test/veilleurConfig.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { validerConfig, lireConfigVeilleur, ecrireConfigVeilleur, empreinteConfig, nomScelle, scellePour, lireConfigScellee, champsDifferents, exclureDeGit } = await import(
  moduleCompile("veilleurConfig.js")
);
const { estFichierSecretBloque, estConfigVeilleur, estCheminProtegeVeilleur } = await import(moduleCompile("fichiersSecrets.js"));
const { cheminRefuse } = await import(moduleCompile("gardeSecrets.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const bonne = {
  actif: true,
  expediteurs: ["maison"],
  agent: null,
  compte: "perso",
  modele: "claude-opus-5-5",
  effort: "medium",
  // T-227 : Bash sans humain impose bypassPermissions (veilleurConfig.ts).
  permission: "bypassPermissions",
  bash: true,
  plafonds: { profondeur: 6, coutParMessage: 5, toursParJour: 100, dureeMin: 20 },
  url: "https://relay.example.net",
  jetonSecret: "relais.jeton",
};

await cas("config valide acceptée", async () => {
  const r = validerConfig(bonne);
  assert("config" in r, "acceptée");
  assert(r.config.expediteurs[0] === "maison", "expediteurs");
  assert(r.config.plafonds.dureeMin === 20, "dureeMin");
});

for (const [nom, patch, attendu] of [
  ["compte Teams refusé", { compte: "teams" }, "perso"],
  ["sans émetteur", { expediteurs: [] }, "expediteurs"],
  ["url non https", { url: "http://x" }, "https"],
  ["profondeur 0", { plafonds: { ...bonne.plafonds, profondeur: 0 } }, "profondeur"],
  ["durée 0", { plafonds: { ...bonne.plafonds, dureeMin: 0 } }, "dureeMin"],
  ["jetonSecret manquant", { jetonSecret: "" }, "jetonSecret"],
  ["bash non booléen", { bash: "oui" }, "bash"],
]) {
  await cas(`invalide : ${nom}`, async () => {
    const r = validerConfig({ ...bonne, ...patch });
    assert("invalide" in r, "rejetée");
    assert(r.invalide.includes(attendu), `raison porte ${attendu} (reçu ${r.invalide})`);
  });
}

await cas("permission imposée par Bash", async () => {
  assert("invalide" in validerConfig({ ...bonne, permission: "acceptEdits" }), "Bash + acceptEdits refusé");
  assert("invalide" in validerConfig({ ...bonne, permission: "default" }), "Bash + default refusé");
  const sans = validerConfig({ ...bonne, bash: false, permission: "acceptEdits" });
  assert("config" in sans, "sans Bash + acceptEdits accepté");
  const r = validerConfig({ ...bonne, bash: false, permission: "bypassPermissions" });
  assert("invalide" in r && r.invalide.includes("acceptEdits"), "sans Bash + bypass refusé");
});

await cas("cadenceSec : défaut 30, bornes 10–600", async () => {
  assert(validerConfig(bonne).config.cadenceSec === 30, "défaut 30");
  assert(validerConfig({ ...bonne, cadenceSec: 10 }).config.cadenceSec === 10, "10 accepté");
  assert(validerConfig({ ...bonne, cadenceSec: 600 }).config.cadenceSec === 600, "600 accepté");
  for (const v of [9, 601, 12.5, "30"]) assert("invalide" in validerConfig({ ...bonne, cadenceSec: v }), `${v} refusé`);
});

await cas("écriture : validée puis atomique, relue à l'identique ; invalide jamais écrite", async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-cfg-ecr-"));
  const r = await ecrireConfigVeilleur(d, { ...bonne, cadenceSec: 45 });
  assert("config" in r, "écrite");
  const relu = await lireConfigVeilleur(d);
  assert("config" in relu && relu.config.cadenceSec === 45 && relu.config.permission === "bypassPermissions", "relue");
  const mauvais = await ecrireConfigVeilleur(d, { ...bonne, compte: "teams" });
  assert("invalide" in mauvais, "refusée");
  const encore = await lireConfigVeilleur(d);
  assert("config" in encore && encore.config.cadenceSec === 45, "l'ancienne reste");
  const restes = (await fsp.readdir(path.join(d, ".iaction"))).filter((f) => f.endsWith(".tmp"));
  assert(restes.length === 0, "aucun temporaire laissé");
});

await cas("bornes réelles : aucun « 0 = illimité »", async () => {
  const p = bonne.plafonds;
  for (const [nom, patch] of [
    ["profondeur 21", { ...p, profondeur: 21 }],
    ["tours 0", { ...p, toursParJour: 0 }],
    ["tours 501", { ...p, toursParJour: 501 }],
    ["coût 0", { ...p, coutParMessage: 0 }],
    ["coût 50.01", { ...p, coutParMessage: 50.01 }],
    ["durée 121", { ...p, dureeMin: 121 }],
    ["profondeur 2.5", { ...p, profondeur: 2.5 }],
  ]) {
    assert("invalide" in validerConfig({ ...bonne, plafonds: patch }), `${nom} refusé`);
  }
  for (const patch of [{ ...p, profondeur: 20, toursParJour: 500, coutParMessage: 50, dureeMin: 120 }, { ...p, profondeur: 1, toursParJour: 1, coutParMessage: 0.01, dureeMin: 1 }]) {
    assert("config" in validerConfig({ ...bonne, plafonds: patch }), `bornes incluses : ${JSON.stringify(patch)}`);
  }
});

await cas("émetteurs : forme d'un nom de boîte exigée", async () => {
  for (const e of ["?", " ", "", "Maison", "a b", "-x", "x".repeat(32)]) {
    assert("invalide" in validerConfig({ ...bonne, expediteurs: [e] }), `${JSON.stringify(e)} refusé`);
  }
  assert("config" in validerConfig({ ...bonne, expediteurs: ["maison", "poste-2"] }), "noms valides acceptés");
});

await cas("le scellé ne peut pas servir de jeton", async () => {
  for (const j of ["veilleur.empreinte", "veilleur.empreinte.abcd1234", "veilleur.empreinte-x"]) {
    assert("invalide" in validerConfig({ ...bonne, jetonSecret: j }), `${j} refusé`);
  }
});

await cas("scellé par projet : nom dérivé du chemin réel, config confrontée au coffre", async () => {
  const d = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-scelle-")));
  const lien = `${d}-lien`;
  await fsp.symlink(d, lien);
  const nom = nomScelle(d);
  assert(/^veilleur\.empreinte\.[0-9a-f]{8}$/.test(nom), nom);
  assert(nomScelle(`${d}-autre`) !== nom, "un nom par projet");
  const config = validerConfig(bonne).config;
  const viaLien = await scellePour(lien, config);
  assert(viaLien.nom === nom, "le lien symbolique désigne le même projet");
  await ecrireConfigVeilleur(d, bonne);
  const table = { [viaLien.nom]: viaLien.empreinte };
  const contient = (n, v) => table[n] === v;
  const ok = await lireConfigScellee(d, contient);
  assert("config" in ok && ok.scellee === true, "approuvée");
  await fsp.writeFile(path.join(d, ".iaction", "veilleur.json"), JSON.stringify({ ...bonne, url: "https://ailleurs.example.net" }));
  const ko = await lireConfigScellee(d, contient);
  assert("config" in ko && ko.scellee === false, "réécrite : plus approuvée");
});

await cas("empreinte : stable, sensible à chaque champ et au projet", async () => {
  const c = validerConfig(bonne).config;
  const h = empreinteConfig("/p", c);
  assert(/^[0-9a-f]{64}$/.test(h), "sha256 hex");
  assert(empreinteConfig("/p", { ...c }) === h, "stable (ordre des clés indifférent)");
  const reordonne = validerConfig(Object.fromEntries(Object.entries(bonne).reverse())).config;
  assert(empreinteConfig("/p", reordonne) === h, "clés triées");
  for (const autre of [{ ...c, url: "https://ailleur.example.net" }, { ...c, jetonSecret: "autre" }, { ...c, expediteurs: ["maison", "autre"] }, { ...c, plafonds: { ...c.plafonds, coutParMessage: 6 } }, { ...c, actif: false }]) {
    assert(empreinteConfig("/p", autre) !== h, `changement vu : ${JSON.stringify(autre).slice(0, 60)}`);
  }
  assert(empreinteConfig("/q", c) !== h, "lié au projet");
});

await cas("empreinte : le CONTENU du fichier d'agent et de l'autorité de certification en fait partie", async () => {
  const d = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-contenus-")));
  const agent = path.join(d, "agent.yaml");
  await fsp.writeFile(agent, "instructions: publie");
  await fsp.writeFile(path.join(d, "ca.pem"), "CERT-1");
  const c = validerConfig({ ...bonne, agent: "pub", ca: "ca.pem" }).config;
  const deps = { cheminAgent: async () => agent };
  const h1 = (await scellePour(d, c, deps)).empreinte;
  await fsp.writeFile(agent, "instructions: tout autre chose");
  const h2 = (await scellePour(d, c, deps)).empreinte;
  assert(h1 !== h2, "agent modifié : empreinte changée");
  await fsp.writeFile(path.join(d, "ca.pem"), "CERT-2");
  const h3 = (await scellePour(d, c, deps)).empreinte;
  assert(h2 !== h3, "certificat modifié : empreinte changée");
  const sansAgent = (await scellePour(d, c, { cheminAgent: async () => null })).empreinte;
  assert(sansAgent !== h3, "agent introuvable : empreinte distincte");
});

await cas("champs qui diffèrent de la version approuvée", async () => {
  const a = validerConfig(bonne).config;
  const b = { ...a, url: "https://ailleurs.example.net", plafonds: { ...a.plafonds, coutParMessage: 9 } };
  assert(JSON.stringify(champsDifferents(a, b)) === JSON.stringify(["plafonds.coutParMessage", "url"]), JSON.stringify(champsDifferents(a, b)));
  assert(champsDifferents(a, a).length === 0, "aucun");
});

await cas("exclusion git LOCALE : ajoutée sans doublon ; pas de dépôt : rien ; worktree : dossier commun", async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-git-"));
  assert((await exclureDeGit(d)) === null, "pas un dépôt : rien");
  await fsp.mkdir(path.join(d, ".git", "info"), { recursive: true });
  await fsp.writeFile(path.join(d, ".git", "info", "exclude"), "# déjà là\n*.log");
  await exclureDeGit(d);
  await exclureDeGit(d);
  const texte = await fsp.readFile(path.join(d, ".git", "info", "exclude"), "utf8");
  assert(texte.startsWith("# déjà là\n*.log\n"), "contenu existant gardé");
  assert(texte.split("\n").filter((l) => l === "/.iaction/veilleur.json").length === 1 && texte.includes("/relais-recu/"), texte);
  await assert(!(await fsp.readFile(path.join(d, ".gitignore"), "utf8").catch(() => null)), "aucun .gitignore écrit");
  // Worktree : `.git` est un fichier `gitdir:`, l'exclusion va au dossier commun.
  const w = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-wt-"));
  const gitdir = path.join(d, ".git", "worktrees", "w");
  await fsp.mkdir(gitdir, { recursive: true });
  await fsp.writeFile(path.join(gitdir, "commondir"), "../..");
  await fsp.writeFile(path.join(w, ".git"), `gitdir: ${gitdir}\n`);
  await fsp.writeFile(path.join(d, ".git", "info", "exclude"), "");
  await exclureDeGit(w);
  assert((await fsp.readFile(path.join(d, ".git", "info", "exclude"), "utf8")).includes("/relais-recu/"), "dossier commun du dépôt");
});

await cas("lecture : un fichier illisible (autre qu'absent) est invalide, pas absent", async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-cfg-dir-"));
  await fsp.mkdir(path.join(d, ".iaction", "veilleur.json"), { recursive: true });
  const r = await lireConfigVeilleur(d);
  assert("invalide" in r && r.invalide.includes("illisible"), `invalide (reçu ${JSON.stringify(r)})`);
});

await cas("garde : chemins normalisés (Windows, barres doubles, casse, points finaux)", async () => {
  for (const c of ["p//.iaction//veilleur.json", "p\\.IACTION\\Veilleur.JSON", "p/.iaction/veilleur.json.", "p/.iaction./veilleur.json ", ".iaction/veilleur.json"]) {
    assert(estConfigVeilleur(c) && estFichierSecretBloque(c), `reconnu : ${JSON.stringify(c)}`);
  }
  assert(estFichierSecretBloque("p/.env."), ".env. reconnu");
  assert(!estConfigVeilleur("p/x.iaction/veilleur.json"), "autre dossier non concerné");
});

await cas("garde du tour veilleur : .mcp.json, .claude/settings*.json et .iaction/ refusés en plus", async () => {
  const cwd = "/projet";
  for (const [outil, entree] of [
    ["Write", { file_path: "/projet/.mcp.json" }],
    ["Edit", { file_path: ".claude/settings.local.json" }],
    ["Write", { file_path: "/projet/.iaction/routage.yaml" }],
    ["Bash", { command: "echo x > .iaction/veilleur.json" }],
    ["Write", { file_path: "/projet/.IACTION./x" }],
  ]) {
    assert(cheminRefuse(cwd, outil, entree, true) !== null, `refusé au veilleur : ${JSON.stringify(entree)}`);
  }
  assert(cheminRefuse(cwd, "Write", { file_path: "/projet/.mcp.json" }, false) === null, "permis hors veilleur");
  assert(cheminRefuse(cwd, "Write", { file_path: "/projet/src/x.ts" }, true) === null, "le code reste écrivable");
  assert(estCheminProtegeVeilleur(".claude/settings.json") && !estCheminProtegeVeilleur(".claude/agents/x.md"), "settings seulement");
});

await cas("ca et proxy optionnels conservés", async () => {
  const r = validerConfig({ ...bonne, ca: "PEM", proxy: "http://p:8080" });
  assert("config" in r && r.config.ca === "PEM" && r.config.proxy === "http://p:8080", "optionnels");
});

await cas("lecture : absent / invalide / valide", async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-cfg-"));
  assert("absent" in (await lireConfigVeilleur(d)), "absent");
  await fsp.mkdir(path.join(d, ".iaction"), { recursive: true });
  await fsp.writeFile(path.join(d, ".iaction", "veilleur.json"), "pas json", "utf8");
  assert("invalide" in (await lireConfigVeilleur(d)), "invalide");
  await fsp.writeFile(path.join(d, ".iaction", "veilleur.json"), JSON.stringify(bonne), "utf8");
  assert("config" in (await lireConfigVeilleur(d)), "valide");
});

await cas("garde : un agent ne peut pas écrire veilleur.json", async () => {
  assert(estConfigVeilleur("projet/.iaction/veilleur.json"), "reconnu");
  assert(estConfigVeilleur("projet\\.iaction\\veilleur.json"), "reconnu (Windows)");
  assert(estFichierSecretBloque("projet/.iaction/veilleur.json"), "bloqué à l'écriture");
  assert(!estConfigVeilleur("projet/.iaction/autre.json"), "autre json non concerné");
});

console.log(`veilleurConfig : ${ok} cas OK`);
