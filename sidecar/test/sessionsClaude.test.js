/*
 * Sessions Claude du poste (T-159) : analyse de `claude agents --json`, binaire
 * absent, délai, code de sortie, JSON invalide. Les faux CLI sont des scripts
 * lancés par `process.execPath` : aucun shebang, donc rien qui dépende de l'OS.
 *
 * Lancement isolé : node sidecar/test/sessionsClaude.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { analyserSessions, binaireExtensionVscode, candidatsBinaire, listerSessions } = await import(
  moduleCompile("sessionsClaude.js")
);

const cwd = path.join(os.tmpdir(), "projet-exemple");

async function fauxCli(corps) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-agents-"));
  const script = path.join(dir, "faux-claude.mjs");
  await fsp.writeFile(script, corps);
  return { candidats: [process.execPath], argsAvant: [script] };
}

async function echoue(promesse) {
  try {
    await promesse;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

await lancer("l'analyse lit les champs d'une session réelle", async () => {
  const sortie = JSON.stringify([
    { pid: 473635, cwd, kind: "interactive", startedAt: 1792438061712, sessionId: "a39b8619", name: "demo-38", status: "busy" },
  ]);
  const { sessions, ignorees } = analyserSessions(sortie);
  assert(ignorees === 0 && sessions.length === 1, "une session attendue");
  const s = sessions[0];
  assert(s.sessionId === "a39b8619" && s.name === "demo-38" && s.status === "busy", "champs texte");
  assert(s.cwd === cwd && s.pid === 473635 && s.startedAt === 1792438061712, "cwd, pid, démarrage");
});

await lancer("les champs manquants sont tolérés, l'absence d'identifiant écarte l'entrée", async () => {
  const { sessions, ignorees } = analyserSessions(JSON.stringify([{ sessionId: "x" }, { name: "sans id" }, 42, null]));
  assert(sessions.length === 1 && ignorees === 3, "une gardée, trois écartées");
  const s = sessions[0];
  assert(s.name === null && s.cwd === null && s.kind === null && s.status === null && s.pid === null && s.startedAt === null, "le reste vaut null");
});

await lancer("un JSON invalide ou un non-tableau lève un message lisible", async () => {
  const m1 = await echoue(Promise.resolve().then(() => analyserSessions("pas du json")));
  assert(m1 !== null && m1.includes("JSON invalide"), `message JSON invalide attendu : ${m1}`);
  const m2 = await echoue(Promise.resolve().then(() => analyserSessions('{"a":1}')));
  assert(m2 !== null && m2.includes("tableau"), `message « tableau » attendu : ${m2}`);
});

await lancer("binaire absent : message clair qui nomme ce qui a été essayé", async () => {
  const absent = path.join(os.tmpdir(), "iaction-binaire-inexistant");
  const msg = await echoue(listerSessions({ candidats: [absent] }));
  assert(msg !== null && msg.includes("introuvable") && msg.includes(absent), `message attendu : ${msg}`);
});

await lancer("un binaire absent laisse la main au candidat suivant", async () => {
  const absent = path.join(os.tmpdir(), "iaction-binaire-inexistant");
  const bon = await fauxCli('console.log(JSON.stringify([{sessionId:"ok"}]));');
  const { sessions } = await listerSessions({ candidats: [absent, ...bon.candidats], argsAvant: bon.argsAvant });
  assert(sessions.length === 1 && sessions[0].sessionId === "ok", "le second candidat doit répondre");
});

await lancer("les arguments passés au CLI sont agents --json, plus --all sur demande", async () => {
  const cli = await fauxCli("console.log(JSON.stringify(process.argv.slice(2).map((a, i) => ({ sessionId: String(i) + a }))));");
  const sans = await listerSessions({ ...cli });
  assert(sans.sessions.map((s) => s.sessionId).join(",") === "0agents,1--json", "agents --json seulement");
  const avec = await listerSessions({ ...cli, toutes: true });
  assert(avec.sessions.map((s) => s.sessionId).join(",") === "0agents,1--json,2--all", "--all ajouté");
});

await lancer("délai dépassé : message de délai, et le processus est tué", async () => {
  const cli = await fauxCli("setTimeout(() => {}, 60000);");
  const debut = Date.now();
  const msg = await echoue(listerSessions({ ...cli, delaiMs: 300 }));
  assert(msg !== null && msg.includes("aucune réponse"), `message de délai attendu : ${msg}`);
  assert(Date.now() - debut < 5000, "la borne doit être respectée");
});

await lancer("code de sortie non nul : message avec code et stderr", async () => {
  const cli = await fauxCli('console.error("boum"); process.exit(3);');
  const msg = await echoue(listerSessions({ ...cli }));
  assert(msg !== null && msg.includes("code de sortie 3") && msg.includes("boum"), `message attendu : ${msg}`);
});

await lancer("sortie non JSON du CLI : message JSON invalide", async () => {
  const cli = await fauxCli('console.log("bonjour");');
  const msg = await echoue(listerSessions({ ...cli }));
  assert(msg !== null && msg.includes("JSON invalide"), `message attendu : ${msg}`);
});

await lancer("les candidats vont du binaire embarqué au PATH puis à l'extension VSCode", () => {
  const env = { platform: "linux", env: {}, home: os.tmpdir() };
  const emb = path.join(os.tmpdir(), "emb", "claude");
  const ext = path.join(os.tmpdir(), "ext", "claude");
  assert(candidatsBinaire(env, emb, ext).join("|") === [emb, "claude", ext].join("|"), "ordre embarqué, PATH, extension");
  assert(candidatsBinaire(env, null, null).join("|") === "claude", "PATH seul sinon");
});

await lancer("l'extension VSCode : la version la plus récente l'emporte", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-home-"));
  const exe = "claude";
  for (const v of ["2.1.9", "2.1.10"]) {
    const dir = path.join(home, ".vscode", "extensions", `anthropic.claude-code-${v}-linux-x64`, "resources", "native-binary");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, exe), "");
  }
  const trouve = binaireExtensionVscode({ platform: "linux", env: {}, home });
  const attendu = path.join(home, ".vscode", "extensions", "anthropic.claude-code-2.1.10-linux-x64", "resources", "native-binary", exe);
  assert(trouve === attendu, `attendu ${attendu}, obtenu ${trouve}`);
  assert(binaireExtensionVscode({ platform: "linux", env: {}, home: path.join(home, "vide") }) === null, "null sans extension");
});
