/*
 * Ce qui borne un tour du veilleur sans passer par le réseau (T-227) :
 * - le scellé n'est accepté que de la classe `coffre` (chiffrée), jamais du
 *   trousseau `sans-fenetre` ni d'une coquille ancienne (mcpSecrets.ts) ;
 * - la composition du serveur interne `iaction` pour un tour du veilleur et un
 *   tour ordinaire (knowledge.ts) ;
 * - le mode de garde d'écriture d'un tour du veilleur, avec ou sans Bash
 *   (gardeSecrets.ts).
 *
 * Lancement isolé : node sidecar/test/veilleurCoffre.test.js
 */

import { assert, fail, moduleCompile } from "./harness.mjs";

const secrets = await import(moduleCompile("mcpSecrets.js"));
const { optionsServeurInterne, composerOutilsIaction } = await import(moduleCompile("knowledge.js"));
const { modeVeilleur, cheminRefuse } = await import(moduleCompile("gardeSecrets.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const SCELLE = "veilleur.empreinte.abcd1234";

await cas("scellé présent seulement côté sans-fenetre : NON reconnu", async () => {
  // La table pousse le nom, mais la coquille ne le déclare pas de classe `coffre`.
  secrets.chargerCoffre("ouvert", { [SCELLE]: "h", "relais.jeton": "j" }, ["relais.jeton"]);
  assert(secrets.coffreContient(SCELLE, "h") === true, "la table à plat le contient");
  assert(secrets.coffreChiffreContient(SCELLE, "h") === false, "mais il ne vient pas du coffre chiffré");
});

await cas("scellé de classe coffre : reconnu ; valeur différente : non", async () => {
  secrets.chargerCoffre("ouvert", { [SCELLE]: "h" }, [SCELLE]);
  assert(secrets.coffreChiffreContient(SCELLE, "h") === true, "reconnu");
  assert(secrets.coffreChiffreContient(SCELLE, "autre") === false, "valeur différente");
});

await cas("coquille ancienne (sans classe) : aucun scellé", async () => {
  secrets.chargerCoffre("ouvert", { [SCELLE]: "h" });
  assert(secrets.coffreChiffreContient(SCELLE, "h") === false, "forme ancienne : pas de scellé");
});

await cas("coffre verrouillé : aucun scellé, même déclaré", async () => {
  secrets.chargerCoffre("verrouille", { [SCELLE]: "h" }, [SCELLE]);
  assert(secrets.coffreChiffreContient(SCELLE, "h") === false, "verrouillé");
  secrets.chargerCoffre("absent", {});
});

await cas("serveur interne : un tour du veilleur n'a ni relais_* ni sessions distantes", async () => {
  const v = optionsServeurInterne({ veilleur: true });
  const outilsVeilleur = composerOutilsIaction({ ...v, knowledge: true });
  assert(!outilsVeilleur.some((t) => t.startsWith("relais_") || t.includes("distante")), `veilleur : ${outilsVeilleur}`);
  assert(JSON.stringify(outilsVeilleur) === JSON.stringify(["search_chat", "lire_usage", "search_knowledge"]), `reste : ${outilsVeilleur}`);
  const o = optionsServeurInterne({});
  const ordinaires = composerOutilsIaction({ ...o, knowledge: false });
  assert(ordinaires.includes("relais_demander") && ordinaires.includes("session_distante_demander"), `ordinaire : ${ordinaires}`);
});

await cas("garde : sans Bash, tout .claude/ et CLAUDE.md protégés dans un tour du veilleur", async () => {
  const sansBash = modeVeilleur({ veilleur: true, tools: ["Read", "Edit"] });
  const avecBash = modeVeilleur({ veilleur: true });
  assert(sansBash.sansBash === true && avecBash.sansBash === false && modeVeilleur({}) === null, "modes");
  for (const f of ["/p/CLAUDE.md", "/p/.claude/agents/x.md", "/p/sous/CLAUDE.md"]) {
    assert(cheminRefuse("/p", "Write", { file_path: f }, sansBash) !== null, `sans Bash : ${f} refusé`);
    assert(cheminRefuse("/p", "Write", { file_path: f }, avecBash) === null, `avec Bash : ${f} permis (barrière contre la maladresse)`);
  }
  assert(cheminRefuse("/p", "Write", { file_path: "/p/.claude/settings.json" }, avecBash) !== null, "settings toujours refusés");
});

await cas("activation refusée pendant un arrêt en cours ou un blocage", async () => {
  const { refusActivation } = await import(moduleCompile("veilleurProtocole.js"));
  assert(refusActivation("arret-en-cours").includes("attends la fin de l'arrêt"), "arrêt en cours");
  assert(refusActivation("bloque").includes("relance l'application"), "bloqué");
  for (const e of ["inactif", "actif", "suspendu", "invalide", "en-attente-coffre"]) assert(refusActivation(e) === null, `${e} : permis`);
});

console.log(`veilleurCoffre : ${ok} cas OK`);
