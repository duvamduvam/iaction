/*
 * Fonctions pures du moteur neutre (sidecar/src/neutralAgent.ts).
 *
 * Les trois fonctions testées sont les trois GARDES du moteur : le bac à sable
 * des chemins, l'allowlist d'outils, et la politique de permissions. Un défaut
 * dans l'une d'elles n'est pas un bug d'affichage — c'est un agent qui lit
 * hors du projet ou exécute du shell sans qu'on le lui ait permis.
 *
 * Lancement isolé : node sidecar/test/neutralAgentPur.test.js
 */

import path from "node:path";

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { normaliserModePourMoteur, versModeNeutre } = await import(moduleCompile("permissions.js"));
const { needsPermission, resolveAllowedTools, resolveSafePath } = await import(
  moduleCompile("neutralAgent.js")
);

/*
 * T-014 — le cwd d'essai part de la racine RÉELLE de la plateforme.
 *
 * `path.join(path.sep, …)` donne « \projet\demo » sous Windows : une forme que
 * Windows ne tient pas pour pleinement qualifiée, et à laquelle `path.resolve`
 * ajoute le lecteur courant. Le test comparait donc « \projet\demo\src\main.ts »
 * à « D:\projet\demo\src\main.ts » — deux écritures du même chemin — et
 * échouait sur le runner Windows alors que la garde, elle, est correcte
 * (elle résout `cwd` avant toute comparaison).
 *
 * Sous Linux la racine vaut « / » et rien ne change.
 */
const racine = path.parse(path.resolve(path.sep)).root;
const cwd = path.join(racine, "projet", "demo");

async function testResolveSafePath() {
  // Le cas nominal : chemin relatif résolu DANS le cwd.
  const ok = resolveSafePath(cwd, path.join("src", "main.ts"));
  assert(ok.ok === true && ok.abs === path.join(cwd, "src", "main.ts"),
    `chemin relatif sain accepté, reçu ${JSON.stringify(ok)}`);

  // L'attaque classique : remonter au-dessus du projet.
  assert(resolveSafePath(cwd, path.join("..", "..", "etc", "passwd")).ok === false,
    "la remontée par .. est refusée");

  // Un chemin absolu HORS projet, donné tel quel.
  assert(resolveSafePath(cwd, path.join(path.sep, "etc", "passwd")).ok === false,
    "un chemin absolu hors projet est refusé");

  // Le piège du préfixe : /projet/demo-evil COMMENCE par /projet/demo.
  // Sans le séparateur dans la comparaison, il passerait.
  assert(resolveSafePath(cwd, `${cwd}-evil${path.sep}fichier`).ok === false,
    "un frère au nom préfixé (« demo-evil ») ne passe pas pour le projet");

  // Le cwd lui-même est un chemin valide (list_dir ".").
  assert(resolveSafePath(cwd, ".").ok === true, "« . » désigne le cwd, accepté");

  // Détour par un sous-dossier qui ressort puis re-rentre : résolu, donc sain.
  const detour = resolveSafePath(cwd, path.join("src", "..", "autre.ts"));
  assert(detour.ok === true && detour.abs === path.join(cwd, "autre.ts"),
    "un .. qui reste DANS le projet est accepté après résolution");
  console.log("OK: resolveSafePath — remontée, absolu, frère préfixé");
}

async function testResolveAllowedTools() {
  // Pas de champ tools : null = palette complète (le manifeste n'a rien restreint).
  assert(resolveAllowedTools(undefined) === null && resolveAllowedTools("tout") === null,
    "allowlist absente ou mal formée ⇒ null (pas de restriction déclarée)");

  // Une liste mal typée n'est PAS « rien » : elle est ignorée comme déclaration.
  assert(resolveAllowedTools(["read_file", 42]) === null,
    "liste hétérogène ⇒ null, on ne devine pas");

  // Allowlist vide : l'agent n'a QUE les outils hors-allowlist (lecture seule
  // de la connaissance). Fermé par défaut.
  const vide = resolveAllowedTools([]);
  assert(vide.size === 1 && vide.has("search_knowledge"),
    `allowlist vide ⇒ seulement search_knowledge, reçu ${[...vide]}`);

  // Les noms Claude Code sont traduits : un agent engine:auto ne sait pas où
  // il tombera.
  const claude = resolveAllowedTools(["Read", "Grep", "Bash"]);
  for (const attendu of ["read_file", "search", "bash", "search_knowledge"]) {
    assert(claude.has(attendu), `traduction Claude→neutre : ${attendu} attendu`);
  }
  assert(!claude.has("write_file") && !claude.has("edit_file"),
    "Read/Grep/Bash ne donnent PAS l'écriture");

  // Un nom inconnu des deux mondes est ignoré — jamais la palette complète.
  const inconnu = resolveAllowedTools(["OutilFantaisie"]);
  assert(inconnu.size === 1 && inconnu.has("search_knowledge"),
    "nom inconnu ⇒ ignoré, l'agent reste sans outil");
  console.log("OK: resolveAllowedTools — fermé par défaut, traduction Claude");
}

async function testNeedsPermission() {
  // Mode par défaut : toute écriture et tout shell demandent.
  for (const outil of ["write_file", "edit_file", "bash"]) {
    assert(needsPermission(outil, "default") === true, `default : ${outil} demande`);
  }
  for (const outil of ["read_file", "list_dir", "search", "search_knowledge"]) {
    assert(needsPermission(outil, "default") === false, `default : ${outil} libre (lecture)`);
  }

  // acceptEdits : les ÉCRITURES passent, le shell demande toujours — c'est
  // toute la différence entre « je te laisse éditer » et « je te laisse tout ».
  assert(needsPermission("write_file", "acceptEdits") === false, "acceptEdits : écriture libre");
  assert(needsPermission("bash", "acceptEdits") === true, "acceptEdits : bash demande ENCORE");

  // bypassPermissions : plus aucune demande — y compris bash.
  assert(needsPermission("bash", "bypassPermissions") === false, "bypass : bash libre");

  // Étape 11 — le registre porte aussi le repli « plan/neutre » (copié 7×
  // avant lui) et la coercition d'entrée du moteur neutre.
  assert(normaliserModePourMoteur("plan", "neutral") === "default", "plan/neutre -> default");
  assert(normaliserModePourMoteur("plan", "claude") === "plan", "plan/claude -> intact (le SDK juge)");
  assert(normaliserModePourMoteur("bypassPermissions", "neutral") === "bypassPermissions", "bypass/neutre -> intact");
  assert(versModeNeutre("plan") === "default", "coercition : plan -> default");
  assert(versModeNeutre(undefined) === "default", "coercition : absent -> default");
  assert(versModeNeutre("acceptEdits") === "acceptEdits", "coercition : acceptEdits conservé");

  // plan n'est pas un mode plus permissif : il demande comme default.
  assert(needsPermission("bash", "plan") === true && needsPermission("write_file", "plan") === true,
    "plan : demande comme default");
  console.log("OK: needsPermission — default/acceptEdits/bypass/plan");
}

await lancer(
  "moteur neutre — les trois gardes",
  testResolveSafePath,
  testResolveAllowedTools,
  testNeedsPermission,
);
