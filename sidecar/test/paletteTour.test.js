/*
 * Ce que le tour annonce au modèle (T-019).
 *
 * Le ticket butait sur une question qu'aucune ligne de journal ne pouvait
 * trancher : `mcp__studio__ask_user` figure-t-il dans la palette annoncée ?
 * La ligne comptait serveurs et outils sans les nommer. Ces cas verrouillent
 * les deux moitiés du correctif — le fait devient lisible, et l'outil est
 * annoncé par l'instruction système plutôt que par une fiche de RAG.
 *
 * Lancement isolé : node sidecar/test/paletteTour.test.js
 */

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { ASK_USER_TOOL_NAME, ANNONCE_QUESTION_INTERACTIVE, composerInstructionSysteme, resumerPalette } =
  await import(moduleCompile("paletteTour.js"));

function serveur(name, tools, status = "connected") {
  return { name, status, tools };
}

await lancer("la palette dit si l'outil de question est là", async () => {
  const avec = resumerPalette(
    [serveur("studio", [ASK_USER_TOOL_NAME]), serveur("iaction", ["mcp__iaction__search"])],
    ASK_USER_TOOL_NAME,
  );
  assert(avec.questionInteractive === true, `attendu présent, reçu ${JSON.stringify(avec)}`);

  const sans = resumerPalette([serveur("iaction", ["mcp__iaction__search"])], ASK_USER_TOOL_NAME);
  assert(
    sans.questionInteractive === false,
    `l'absence doit se lire comme un FAUX explicite, pas comme un champ manquant : ${JSON.stringify(sans)}`,
  );
});

await lancer("la palette nomme les serveurs, sans déverser 39 noms d'outils", async () => {
  const r = resumerPalette(
    [serveur("studio", [ASK_USER_TOOL_NAME]), serveur("imap", ["a", "b", "c"]), serveur("muet", [])],
    ASK_USER_TOOL_NAME,
  );
  assert(r.serveurs === "studio:1, imap:3, muet:0", `reçu ${r.serveurs}`);
  assert(r.connectes === 2 && r.muets === 1, `comptes: ${JSON.stringify(r)}`);
  assert(r.outils === 4, `outils: ${r.outils}`);
  assert(!String(r.serveurs).includes("mcp__imap"), "les noms d'outils ne doivent pas être listés");
});

await lancer("une palette énorme reste une ligne de journal", async () => {
  const beaucoup = Array.from({ length: 20 }, (_, i) => serveur(`s${i}`, ["x"]));
  const r = resumerPalette(beaucoup, ASK_USER_TOOL_NAME);
  assert(String(r.serveurs).endsWith(", +8"), `le reste doit être compté, reçu ${r.serveurs}`);
  assert(r.outils === 20, `le total, lui, reste exact : ${r.outils}`);
});

await lancer("chat pur : l'annonce n'est faite que si l'outil est armé", async () => {
  // Un tour non interactif (orchestration, planificateur) n'arme pas le
  // serveur : annoncer l'outil y serait un mensonge, et le modèle poserait
  // une question que personne ne verrait.
  assert(composerInstructionSysteme(null, false, false) === undefined, "rien à dire, rien n'est envoyé");
  assert(composerInstructionSysteme(null, true, false) === ANNONCE_QUESTION_INTERACTIVE, "annonce seule");
});

await lancer("chat pur : l'instruction de l'agent n'est jamais écrasée", async () => {
  const agent = "Tu es un relecteur méticuleux.";
  const avec = composerInstructionSysteme(agent, true, false);
  assert(avec.startsWith(agent), `l'instruction de l'agent vient en premier : ${avec}`);
  assert(avec.includes(ASK_USER_TOOL_NAME), "et l'annonce s'y ajoute");

  assert(composerInstructionSysteme(agent, false, false) === agent, "sans annonce, l'instruction passe intacte");
  assert(
    composerInstructionSysteme("   ", true, false) === ANNONCE_QUESTION_INTERACTIVE,
    "une instruction vide ne compte pas",
  );
});

/*
 * T-052 — le défaut que ces cas verrouillent est invisible à l'œil nu : sans
 * `systemPrompt`, le SDK agent n'envoie pas le prompt de Claude Code, il en
 * envoie un VIDE, et une chaîne le REMPLACE. Nos tours de projet servaient donc
 * les outils intégrés sans aucune instruction pour les cadrer.
 */
await lancer("tour de projet : le preset Claude Code est demandé explicitement", async () => {
  const seul = composerInstructionSysteme(null, false, true);
  assert(seul?.type === "preset" && seul.preset === "claude_code", `preset attendu : ${JSON.stringify(seul)}`);
  assert(!("append" in seul), `rien à ajouter ⇒ pas de champ append : ${JSON.stringify(seul)}`);
});

await lancer("tour de projet : l'instruction de l'agent S'AJOUTE au preset", async () => {
  const agent = "Tu es un relecteur méticuleux.";
  const r = composerInstructionSysteme(agent, true, true);
  assert(r.type === "preset", "le preset ne doit jamais être remplacé par l'instruction de l'agent");
  assert(r.append.startsWith(agent), `l'agent d'abord : ${r.append}`);
  assert(r.append.includes(ASK_USER_TOOL_NAME), "puis l'annonce de l'outil de question");
});
