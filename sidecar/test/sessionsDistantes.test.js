/*
 * Client des sessions Remote Control des autres machines (T-165) : liste, jeton,
 * erreurs HTTP, identité de dépôt et relais du `queryFn` distant (permissions,
 * interruption, fin de tour). AUCUN appel réseau : un faux
 * `fetch` et un faux `query` « browser » remplacent les deux frontières.
 *
 * Lancement isolé : node sidecar/test/sessionsDistantes.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, lancer, moduleCompile, sleep } from "./harness.mjs";

const {
  analyserListe,
  cheminJeton,
  identiteDepot,
  creerQueryFnDistant,
  enTetes,
  lireCurseur,
  lireJetonOauth,
  listerSessionsDistantes,
  messageHttp,
  projeterSession,
  URL_API,
  verifierConnectee,
} = await import(moduleCompile("sessionsDistantes.js"));

const JETON = "jeton-factice-pour-test";
const ID_SESSION = "cse_exemple";

async function echoue(promesse) {
  try {
    await promesse;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Faux `fetch` : table `url → {status, corps}` ; consigne les appels. */
function fauxFetch(table) {
  const appels = [];
  const fn = async (url, init) => {
    appels.push({ url: String(url), headers: init?.headers ?? {} });
    const r = table[String(url)];
    if (r instanceof Error) throw r;
    if (!r) return new Response("introuvable", { status: 404 });
    return new Response(typeof r.corps === "string" ? r.corps : JSON.stringify(r.corps), { status: r.status ?? 200 });
  };
  return { fn, appels };
}

const base = `${URL_API}/v1/code/sessions/${ID_SESSION}`;
const reponsesNominales = () => ({
  [base]: { corps: { id: ID_SESSION, connection_status: "connected" } },
  [`${base}/events`]: { corps: { data: [{ sequence_num: "41" }, { sequence_num: "40" }], resume_cursor: "40" } },
});

await lancer("le jeton se lit dans CLAUDE_CONFIG_DIR, sinon ~/.claude, et ne fuit jamais", async () => {
  const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-jeton-"));
  const home = path.join(dossier, "home");
  assert(cheminJeton({ home }) === path.join(home, ".claude", ".credentials.json"), "repli sur ~/.claude");
  assert(cheminJeton({ home, configDir: dossier }) === path.join(dossier, ".credentials.json"), "CLAUDE_CONFIG_DIR prime");

  const absent = await echoue(Promise.resolve().then(() => lireJetonOauth({ home })));
  assert(absent !== null && absent.includes("/login") && absent.includes(cheminJeton({ home })), `jeton absent : ${absent}`);

  const fichier = cheminJeton({ home: dossier, configDir: dossier });
  await fsp.writeFile(fichier, "pas du json");
  const illisible = await echoue(Promise.resolve().then(() => lireJetonOauth({ home: dossier, configDir: dossier })));
  assert(illisible !== null && illisible.includes("JSON invalide"), `JSON invalide : ${illisible}`);

  await fsp.writeFile(fichier, JSON.stringify({ autre: 1 }));
  const sansJeton = await echoue(Promise.resolve().then(() => lireJetonOauth({ home: dossier, configDir: dossier })));
  assert(sansJeton !== null && sansJeton.includes("claude.ai"), `sans accessToken : ${sansJeton}`);

  await fsp.writeFile(fichier, JSON.stringify({ claudeAiOauth: { accessToken: JETON } }));
  assert(lireJetonOauth({ home: dossier, configDir: dossier }) === JETON, "jeton lu");
  // Relu à chaque appel : le renouvellement par Claude Code est vu sans redémarrage.
  await fsp.writeFile(fichier, JSON.stringify({ claudeAiOauth: { accessToken: "renouvele" } }));
  assert(lireJetonOauth({ home: dossier, configDir: dossier }) === "renouvele", "relu à chaque appel");
  await fsp.rm(dossier, { recursive: true, force: true });
});

await lancer("la liste est projetée, les archivées masquées, les écarts de format criés", async () => {
  const entree = {
    id: "cse_a",
    title: "Session exemple",
    status: "active",
    connection_status: "connected",
    worker_status: "idle",
    config: { model: "modele-exemple" },
    tags: ["remote-control-cli", "autre"],
    updated_at: "2026-10-21T10:00:00Z",
  };
  const s = projeterSession(entree);
  assert(s.id === "cse_a" && s.titre === "Session exemple" && s.statut === "active", "champs texte");
  assert(s.connexion === "connected" && s.travail === "idle" && s.modele === "modele-exemple", "connexion, travail, modèle");
  assert(s.origine === "remote-control-cli" && s.majLe === Date.parse("2026-10-21T10:00:00Z"), "origine, dernière activité");

  const vide = projeterSession({ id: "cse_b" });
  assert(vide.titre === null && vide.connexion === null && vide.modele === null && vide.majLe === null, "champs manquants tolérés");
  assert(projeterSession({ title: "sans id" }) === null && projeterSession(42) === null, "sans identifiant : écartée");

  const brut = { data: [entree, { id: "cse_c", status: "archived", updated_at: "2026-10-22T10:00:00Z" }, { title: "x" }] };
  const sansArchivees = analyserListe(brut, false);
  assert(sansArchivees.sessions.length === 1 && sansArchivees.ignorees === 1, "archivée masquée, entrée sans id comptée");
  const avecArchivees = analyserListe(brut, true);
  assert(avecArchivees.sessions.map((x) => x.id).join() === "cse_c,cse_a", "archivées incluses, plus récente d'abord");
  assert(analyserListe([entree], false).sessions.length === 1, "tableau nu accepté");
  const inattendu = await echoue(Promise.resolve().then(() => analyserListe({ foo: 1 }, false)));
  assert(inattendu !== null && inattendu.includes("inattendue"), `format inattendu : ${inattendu}`);
});

await lancer("listerSessionsDistantes : appel authentifié et erreurs HTTP lisibles", async () => {
  const { fn, appels } = fauxFetch({ [`${URL_API}/v1/code/sessions`]: { corps: { data: [{ id: "cse_a", title: "T" }] } } });
  const { sessions } = await listerSessionsDistantes({}, { fetchFn: fn, lireJeton: () => JETON });
  assert(sessions.length === 1 && appels.length === 1, "une requête, une session");
  assert(appels[0].headers.Authorization === `Bearer ${JETON}`, "en-tête Authorization");
  assert(appels[0].headers["anthropic-version"] === "2023-06-01" && appels[0].headers["anthropic-client-platform"] === "cli", "en-têtes de version et de plateforme");

  const url = `${URL_API}/v1/code/sessions`;
  for (const [table, attendu] of [
    [{ [url]: { status: 401, corps: {} } }, "HTTP 401"],
    [{ [url]: { status: 404, corps: {} } }, "HTTP 404"],
    [{ [url]: { status: 500, corps: {} } }, "HTTP 500"],
    [{ [url]: { corps: "<html>" } }, "JSON invalide"],
    [{ [url]: new TypeError("fetch failed") }, "injoignable"],
  ]) {
    const message = await echoue(listerSessionsDistantes({}, { fetchFn: fauxFetch(table).fn, lireJeton: () => JETON }));
    assert(message !== null && message.includes(attendu), `« ${attendu} » attendu, reçu : ${message}`);
    assert(!message.includes(JETON), "le jeton ne figure jamais dans un message");
  }
  assert(messageHttp(401, "x").includes("/login"), "le 401 dit quoi faire");
  const sansJeton = await echoue(listerSessionsDistantes({}, { fetchFn: fn, lireJeton: () => lireJetonOauth({ home: path.join(os.tmpdir(), "inexistant-iaction") }) }));
  assert(sansJeton !== null && sansJeton.includes("/login"), `jeton absent : ${sansJeton}`);
});

await lancer("curseur et état de connexion : écart de format ou session déconnectée = erreur", async () => {
  // Liste du plus récent au plus ancien, `resume_cursor` = le plus ancien : le curseur est le MAX des sequence_num.
  assert(lireCurseur({ data: [{ sequence_num: "9" }, { sequence_num: "8" }, { sequence_num: 1 }], resume_cursor: "1" }) === 9, "plus grand sequence_num, pas resume_cursor");
  assert(lireCurseur({ data: [] }) === 0, "session vide : 0");
  for (const [mauvais, champ] of [[{}, "data"], [{ resume_cursor: "4" }, "data"], [null, "data"], [{ data: [{ sequence_num: "abc" }] }, "sequence_num"], [{ data: [{}] }, "sequence_num"]]) {
    const m = await echoue(Promise.resolve().then(() => lireCurseur(mauvais)));
    assert(m !== null && m.includes(champ), `curseur invalide refusé : ${JSON.stringify(mauvais)}`);
  }
  verifierConnectee({ connection_status: "connected" });
  // T-174 — forme réelle : détail enveloppé dans `response_shape`.
  verifierConnectee({ response_shape: { id: "cse_x", connection_status: "connected" } });
  const enveloppee = await echoue(Promise.resolve().then(() => verifierConnectee({ response_shape: { id: "cse_x", connection_status: "disconnected" } })));
  assert(enveloppee !== null && enveloppee.includes("déconnectée"), "session déconnectée détectée sous response_shape");
  verifierConnectee({}); // champ absent : on n'interdit rien
  const m = await echoue(Promise.resolve().then(() => verifierConnectee({ connection_status: "disconnected" })));
  assert(m !== null && m.includes("déconnectée") && m.includes("disconnected"), `déconnectée refusée : ${m}`);
});

/** Faux `query` browser : consigne ses options, rejoue `messages`, relaie `canUseTool`. */
function fauxQueryBrowser({ messages, avantResultat, refusMode }) {
  const etat = { options: null, interruptions: 0, aborts: 0, modes: [] };
  const query = (options) => {
    etat.options = options;
    options.abortController.signal.addEventListener("abort", () => (etat.aborts += 1));
    async function* flux() {
      for (const m of messages) {
        if (m.type === "result" && avantResultat) await avantResultat(options, etat);
        yield m;
      }
      await new Promise(() => {}); // le vrai flux SSE reste ouvert
    }
    const it = flux();
    return {
      [Symbol.asyncIterator]: () => it,
      interrupt: async () => void (etat.interruptions += 1),
      setPermissionMode: async (mode) => {
        etat.modes.push(mode);
        if (refusMode) throw new Error(refusMode);
      },
    };
  };
  return { query, etat };
}

const MESSAGES = [
  { type: "system", subtype: "init", session_id: "natif-1", model: "modele-exemple", mcp_servers: [], tools: [] },
  { type: "assistant", message: { content: [{ type: "text", text: "bonjour" }] } },
  { type: "result", subtype: "success", session_id: "natif-1", result: "bonjour", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
];

async function* promptUnique() {
  yield { type: "user", message: { role: "user", content: "salut" }, parent_tool_use_id: null };
}

async function lireTout(iterable) {
  const vus = [];
  for await (const m of iterable) vus.push(m);
  return vus;
}

await lancer("le queryFn distant branche le client SSE, relaie canUseTool et s'arrête après le result", async () => {
  const { fn, appels } = fauxFetch(reponsesNominales());
  const { query, etat } = fauxQueryBrowser({
    messages: MESSAGES,
    avantResultat: async (options) => {
      const decision = await options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" });
      etat.decision = decision;
    },
  });
  let demandee = null;
  const queryFn = creerQueryFnDistant(ID_SESSION, { fetchFn: fn, lireJeton: () => JETON, chargerQuery: async () => query });
  const q = queryFn({
    prompt: promptUnique(),
    options: {
      cwd: "ignore",
      model: "ignore",
      permissionMode: "acceptEdits",
      canUseTool: async (outil, entree) => {
        demandee = { outil, entree };
        return { behavior: "allow" };
      },
    },
  });
  const vus = await lireTout(q);
  assert(vus.length === 3 && vus[2].type === "result", "les trois messages, arrêt après le result");
  assert(appels.map((a) => a.url).join() === [base, `${base}/events`].join(), "détail puis curseur, dans cet ordre");
  const sse = etat.options.sse;
  assert(sse.streamUrl === `${base}/events/stream` && sse.sendUrl === `${base}/events`, "URL du flux et d'envoi");
  assert(sse.sessionId === ID_SESSION && sse.fromSequenceNum === 41, "identifiant et curseur de départ");
  assert(sse.headers.Authorization === `Bearer ${JETON}` && sse.headers["anthropic-client-platform"] === "cli", "en-têtes du flux");
  assert(demandee?.outil === "Bash" && demandee.entree.command === "ls", "la demande de permission est relayée au moteur");
  assert(etat.decision?.behavior === "allow", "la décision du moteur revient à la session distante");
  assert(etat.aborts >= 1, "la connexion est coupée en fin de tour");
  assert(!("cwd" in etat.options) && !("model" in etat.options), "les options locales ne sont pas transmises");
  assert(etat.modes.join() === "acceptEdits", "T-167 : le mode de permission d'IAction s'applique à la session distante");
});

await lancer("le queryFn distant : session déconnectée, 401, 404 et curseur absent échouent bruyamment, sans ouvrir de flux", async () => {
  let ouvert = false;
  const chargerQuery = async () => () => {
    ouvert = true;
    throw new Error("ne doit pas être appelé");
  };
  const cas = [
    [{ [base]: { corps: { connection_status: "disconnected" } } }, "déconnectée"],
    [{ [base]: { status: 401, corps: {} } }, "HTTP 401"],
    [{}, "HTTP 404"],
    [{ [base]: { corps: {} }, [`${base}/events`]: { corps: { resume_cursor: "1" } } }, "data"],
  ];
  for (const [table, attendu] of cas) {
    const q = creerQueryFnDistant(ID_SESSION, { fetchFn: fauxFetch(table).fn, lireJeton: () => JETON, chargerQuery })({ prompt: promptUnique() });
    const message = await echoue(lireTout(q));
    assert(message !== null && message.includes(attendu), `« ${attendu} » attendu, reçu : ${message}`);
    assert(!message.includes(JETON), "pas de jeton dans le message");
  }
  assert(!ouvert, "aucun flux ouvert quand la précondition échoue");
});

await lancer("interrupt() est relayé à la machine distante, puis le flux est coupé s'il reste muet", async () => {
  const { fn } = fauxFetch(reponsesNominales());
  const { query, etat } = fauxQueryBrowser({ messages: MESSAGES.slice(0, 2) }); // jamais de result
  const queryFn = creerQueryFnDistant(ID_SESSION, {
    fetchFn: fn,
    lireJeton: () => JETON,
    chargerQuery: async () => query,
    delaiInterruptionMs: 30,
  });
  const q = queryFn({ prompt: promptUnique() });
  const vus = [];
  const lecture = lireTout({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const r = await q[Symbol.asyncIterator]().next();
        if (!r.done) vus.push(r.value);
        return r;
      },
    }),
  });
  while (vus.length < 2) await sleep(5);
  await q.interrupt();
  assert(etat.interruptions === 1, "l'interruption part vers la session distante");
  await lecture; // se termine parce que le flux est coupé après le délai
  assert(etat.aborts >= 1, "le flux muet est coupé");
});

await lancer("T-173 : l'identité de dépôt garde les deux derniers segments, en minuscules", async () => {
  const attendus = [
    "alias:Proprio/Depot.git",
    "git@hote:proprio/depot.git",
    "ssh://git@hote:2222/proprio/depot",
    "https://hote/proprio/depot",
    "https://hote/groupe/sous/proprio/depot.git",
    "https://hote/proprio/depot/",
  ];
  for (const brut of attendus) assert(identiteDepot(brut) === "proprio/depot", `${brut} → ${identiteDepot(brut)}`);
  for (const mauvais of [undefined, null, 42, "", "depot", "https://hote/depot"]) {
    assert(identiteDepot(mauvais) === null, `sans identité : ${JSON.stringify(mauvais)}`);
  }
  const s = projeterSession({ id: "cse_x", config: { outcomes: [{ git_info: { repo: "Proprio/Depot" } }] } });
  assert(s.depot === "proprio/depot", "git_info.repo prime");
  const t = projeterSession({ id: "cse_y", config: { sources: [{ url: "https://hote/proprio/depot.git" }] } });
  assert(t.depot === "proprio/depot", "repli sur sources[].url");
});
