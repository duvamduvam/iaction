/*
 * Outils MCP « sessions distantes » des agents (T-178) : résolution d'une
 * session par titre, tour complet sur faux `fetch` + faux `query` browser,
 * refus des permissions, délai, erreurs. AUCUN appel réseau.
 *
 * Lancement isolé : node sidecar/test/outilsSessionsDistantes.test.js
 */

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { borneDelaiMinutes, demanderASession, formaterListe, ligneOrigine, listerPourAgent, MESSAGE_PERMISSION_REFUSEE, resoudreSession } = await import(
  moduleCompile("outilsSessionsDistantes.js")
);
const { URL_API } = await import(moduleCompile("sessionsDistantes.js"));

const JETON = "jeton-factice-pour-test";
const T0 = Date.parse("2026-10-20T10:00:00Z");
const s = (id, titre, connexion, majLe, depot = "org/depot") => ({ id, titre, statut: "active", connexion, travail: "idle", modele: null, origine: null, majLe, depot });

function fauxFetch(table) {
  const appels = [];
  const fn = async (url) => {
    appels.push(String(url));
    const r = table[String(url)];
    if (r instanceof Error) throw r;
    if (!r) return new Response("introuvable", { status: 404 });
    return new Response(JSON.stringify(r.corps), { status: r.status ?? 200 });
  };
  return { fn, appels };
}

function fauxQuery({ messages, avantResultat, muet }) {
  const etat = { options: null, interruptions: 0, decisions: [] };
  const query = (options) => {
    etat.options = options;
    async function* flux() {
      for (const m of messages) {
        if (m.type === "result" && avantResultat) await avantResultat(options, etat);
        yield m;
      }
      if (muet) await new Promise(() => {});
    }
    const it = flux();
    return { [Symbol.asyncIterator]: () => it, interrupt: async () => void (etat.interruptions += 1) };
  };
  return { query, etat };
}

const base = `${URL_API}/v1/code/sessions`;
const table = () => ({
  [base]: { corps: { data: [{ id: "cse_a", title: "Bureau", connection_status: "connected", updated_at: "2026-10-20T10:00:00Z" }] } },
  [`${base}/cse_a`]: { corps: { id: "cse_a", connection_status: "connected" } },
  [`${base}/cse_a/events`]: { corps: { data: [{ sequence_num: 3 }] } },
});
const MESSAGES = [
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls /x" } }, { type: "text", text: "je regarde" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "voilà" }] } },
  { type: "result", subtype: "success", result: "réponse finale", total_cost_usd: 0.0123, duration_ms: 4200 },
];
const deps = (fetchFn, query, extra = {}) => ({ fetchFn, lireJeton: () => JETON, chargerQuery: async () => query, machine: "poste-test", ...extra });

await lancer("résolution : titre → connectée la plus récente, erreurs explicites", async () => {
  const liste = [s("cse_1", "Bureau", "connected", T0), s("cse_2", "Bureau", "connected", T0 + 10), s("cse_3", "Bureau", "disconnected", T0 + 99), s("cse_4", "Autre", "disconnected", T0)];
  const r = resoudreSession(liste, "Bureau");
  assert(r.ok && r.id === "cse_2", "la connectée la plus récente, la déconnectée plus récente est ignorée");
  assert(resoudreSession(liste, "cse_inconnue").ok, "un identifiant cse_ passe tel quel");
  const rien = resoudreSession(liste, "Absente");
  assert(!rien.ok && rien.message.includes("Aucune session"), "aucune");
  const deco = resoudreSession(liste, "Autre");
  assert(!deco.ok && deco.message.includes("déconnectées"), "toutes déconnectées");
  const ambigu = resoudreSession([s("cse_1", "X", "connected", T0, "a/b"), s("cse_2", "X", "connected", T0, "c/d")], "X");
  assert(!ambigu.ok && ambigu.message.includes("cse_1") && ambigu.message.includes("cse_2"), "ambiguïté entre dépôts nommée");
  assert(borneDelaiMinutes(undefined) === 15 && borneDelaiMinutes(99) === 30 && borneDelaiMinutes(0) === 1 && borneDelaiMinutes(5) === 5, "délai borné");
  assert(formaterListe([]).includes("Aucune") && formaterListe([s("cse_1", "T", "connected", T0)]).includes("cse_1"), "liste lisible");
  assert(ligneOrigine("poste-test") === "[Message d'un agent de poste-test via IAction]", "ligne d'origine générique");
});

await lancer("lister : liste projetée, erreur HTTP en résultat isError sans jeton", async () => {
  const ok = await listerPourAgent(deps(fauxFetch(table()).fn, null));
  assert(!ok.erreur && ok.texte.includes("Bureau") && ok.texte.includes("cse_a"), ok.texte);
  const ko = await listerPourAgent(deps(fauxFetch({ [base]: { status: 401, corps: {} } }).fn, null));
  assert(ko.erreur && ko.texte.includes("401") && !ko.texte.includes(JETON), ko.texte);
});

await lancer("demander : tour complet, préfixe d'origine, outils résumés, coût, permission refusée signalée", async () => {
  const { fn, appels } = fauxFetch(table());
  const { query, etat } = fauxQuery({
    messages: MESSAGES,
    avantResultat: async (options, e) => void e.decisions.push(await options.canUseTool("Write", { file_path: "/y" }, { signal: new AbortController().signal, toolUseID: "t" })),
  });
  const r = await demanderASession({ session: "Bureau", message: "Quelle est la situation ?" }, deps(fn, query));
  assert(!r.erreur, r.texte);
  assert(r.texte.startsWith("réponse finale"), "texte final");
  assert(r.texte.includes("Bash : ls /x"), "outils utilisés résumés");
  assert(r.texte.includes("0.0123") && r.texte.includes("4.2 s"), "coût et durée");
  assert(etat.decisions[0].behavior === "deny" && etat.decisions[0].message === MESSAGE_PERMISSION_REFUSEE, "permission refusée avec le message de la spec");
  assert(r.texte.includes("REFUSÉE") && r.texte.includes("Write"), "refus signalé dans le résultat");
  assert(appels[0] === base && appels[1] === `${base}/cse_a`, "liste puis vérification de connexion");
  const premier = await etat.options.prompt[Symbol.asyncIterator]().next();
  const texte = premier.value.message.content[0].text;
  assert(texte.startsWith("[Message d'un agent de poste-test via IAction]") && texte.endsWith("Quelle est la situation ?"), texte);
});

await lancer("demander : délai dépassé, session déconnectée, paramètres vides = isError lisibles", async () => {
  const { query, etat } = fauxQuery({ messages: MESSAGES.slice(0, 1), muet: true });
  const lent = await demanderASession({ session: "cse_a", message: "m" }, deps(fauxFetch(table()).fn, query, { delaiAttenteMs: 40, delaiInterruptionMs: 30 }));
  assert(lent.erreur && lent.texte.includes("Délai dépassé"), lent.texte);
  assert(etat.interruptions === 1, "l'interruption part vers la session distante");

  const deco = table();
  deco[`${base}/cse_a`] = { corps: { id: "cse_a", connection_status: "disconnected" } };
  const d = await demanderASession({ session: "cse_a", message: "m" }, deps(fauxFetch(deco).fn, null));
  assert(d.erreur && d.texte.includes("déconnectée"), d.texte);

  const inconnue = await demanderASession({ session: "Absente", message: "m" }, deps(fauxFetch(table()).fn, null));
  assert(inconnue.erreur && inconnue.texte.includes("Aucune session"), inconnue.texte);
  const vide = await demanderASession({ session: "Bureau", message: "  " }, deps(fauxFetch(table()).fn, null));
  assert(vide.erreur && vide.texte.includes("message"), vide.texte);
  const sans = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(table()).fn, fauxQuery({ messages: [] }).query));
  assert(sans.erreur && sans.texte.includes("sans rendre de réponse"), sans.texte);
  const echec = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(table()).fn, fauxQuery({ messages: [{ type: "result", subtype: "error_during_execution", result: "" }] }).query));
  assert(echec.erreur, "tour distant en échec = isError");
});

// T-185 — fenêtres de question quand un humain est devant l'écran (pont `demanderUtilisateur`).
function fauxDemander(reponses) {
  const poses = [];
  const fn = async (questions) => {
    poses.push(questions[0]);
    const r = reponses.shift();
    return r === undefined ? { answered: false, text: "" } : { answered: true, text: r };
  };
  return { fn, poses };
}

await lancer("T-185 : session déconnectée → question, « Réessayer » relit l'état et envoie", async () => {
  const t = table();
  const liste = t[base];
  t[base] = { corps: { data: [{ ...liste.corps.data[0], connection_status: "disconnected" }] } };
  const { fn: fetchFn } = fauxFetch(t);
  const { fn, poses } = fauxDemander(["Réessayer"]);
  let lectures = 0;
  const fetchBascule = async (url) => {
    if (String(url) === base && ++lectures === 2) t[base] = liste; // relancée entre-temps
    return fetchFn(url);
  };
  const r = await demanderASession({ session: "Bureau", message: "m" }, deps(fetchBascule, fauxQuery({ messages: MESSAGES }).query, { demanderUtilisateur: fn }));
  assert(!r.erreur && r.texte.startsWith("réponse finale"), r.texte);
  assert(poses.length === 1 && poses[0].question.includes("n'est pas joignable") && poses[0].context.includes("remote-control"), JSON.stringify(poses));
});

await lancer("T-185 : « Abandonner » ou question ignorée → erreur lisible ; session absente aussi", async () => {
  const t = table();
  t[base] = { corps: { data: [] } };
  const { fn, poses } = fauxDemander(["Abandonner"]);
  const r = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(t).fn, null, { demanderUtilisateur: fn }));
  assert(r.erreur && r.texte.includes("abandonné par l'utilisateur"), r.texte);
  assert(poses.length === 1, "une seule question");
  const ignoree = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(t).fn, null, { demanderUtilisateur: fauxDemander([]).fn }));
  assert(ignoree.erreur, "question ignorée = abandon");
});

await lancer("T-185 : validation en attente là-bas → question avec « Envoyer quand même »", async () => {
  const t = table();
  t[base] = { corps: { data: [{ ...t[base].corps.data[0], worker_status: "requires_action" }] } };
  const { fn, poses } = fauxDemander(["Envoyer quand même"]);
  const r = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(t).fn, fauxQuery({ messages: MESSAGES }).query, { demanderUtilisateur: fn }));
  assert(!r.erreur, r.texte);
  assert(poses[0].question.includes("attend une validation") && poses[0].options.some((o) => o.label === "Envoyer quand même"), JSON.stringify(poses[0]));
  // Sans pont (tour headless) : comportement d'origine, envoi sans question.
  const headless = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(t).fn, fauxQuery({ messages: MESSAGES }).query));
  assert(!headless.erreur, headless.texte);
});

await lancer("T-185 : permission distante posée à l'utilisateur — autorisée puis refusée", async () => {
  const pose = async (reponse) => {
    const { query, etat } = fauxQuery({
      messages: MESSAGES,
      avantResultat: async (options, e) => void e.decisions.push(await options.canUseTool("Bash", { command: "dir C:\\x" }, { signal: new AbortController().signal, toolUseID: "t" })),
    });
    const { fn, poses } = fauxDemander([reponse]);
    const r = await demanderASession({ session: "Bureau", message: "m" }, deps(fauxFetch(table()).fn, query, { demanderUtilisateur: fn }));
    return { r, etat, poses };
  };
  const oui = await pose("Autoriser");
  assert(oui.etat.decisions[0].behavior === "allow" && oui.etat.decisions[0].updatedInput.command === "dir C:\\x", JSON.stringify(oui.etat.decisions));
  assert(oui.poses[0].context.includes("dir C:\\x") && oui.poses[0].question.includes("Bash"), JSON.stringify(oui.poses[0]));
  assert(oui.r.texte.includes("accordée(s) par l'utilisateur : Bash"), oui.r.texte);
  const non = await pose("Refuser");
  assert(non.etat.decisions[0].behavior === "deny" && non.r.texte.includes("refusée(s) par l'utilisateur"), non.r.texte);
});

// T-180 — verrou par session distante : même session = file, sessions différentes = parallèle.
function tableDeuxSessions() {
  const t = table();
  t[base] = {
    corps: {
      data: [
        { id: "cse_a", title: "Bureau", connection_status: "connected", updated_at: "2026-10-20T10:00:00Z" },
        { id: "cse_b", title: "Autre", connection_status: "connected", updated_at: "2026-10-20T10:00:00Z" },
      ],
    },
  };
  t[`${base}/cse_b`] = { corps: { id: "cse_b", connection_status: "connected" } };
  t[`${base}/cse_b/events`] = { corps: { data: [{ sequence_num: 1 }] } };
  return t;
}

// Faux query qui mesure la concurrence par session et rend « réponse-<n° d'appel> ».
function fauxQueryCompteur() {
  const suivi = { actifs: new Map(), maxParSession: new Map(), maxGlobal: 0, ordre: [] };
  let global = 0;
  let appel = 0;
  const query = ({ prompt }) => {
    const numero = ++appel;
    async function* flux() {
      const premier = await prompt[Symbol.asyncIterator]().next();
      const id = premier.value.message.content[0].text.includes("pour-b") ? "cse_b" : "cse_a";
      suivi.ordre.push(`debut-${numero}`);
      suivi.actifs.set(id, (suivi.actifs.get(id) ?? 0) + 1);
      global += 1;
      suivi.maxParSession.set(id, Math.max(suivi.maxParSession.get(id) ?? 0, suivi.actifs.get(id)));
      suivi.maxGlobal = Math.max(suivi.maxGlobal, global);
      await new Promise((r) => setTimeout(r, 40));
      suivi.actifs.set(id, suivi.actifs.get(id) - 1);
      global -= 1;
      suivi.ordre.push(`fin-${numero}`);
      yield { type: "result", subtype: "success", result: `réponse-${numero}` };
    }
    const it = flux();
    return { [Symbol.asyncIterator]: () => it, interrupt: async () => undefined };
  };
  return { query, suivi };
}

await lancer("T-180 : deux appels simultanés vers la MÊME session sont sérialisés", async () => {
  const { query, suivi } = fauxQueryCompteur();
  const d = deps(fauxFetch(tableDeuxSessions()).fn, query);
  const [r1, r2] = await Promise.all([
    demanderASession({ session: "Bureau", message: "pour-a 1" }, d),
    demanderASession({ session: "cse_a", message: "pour-a 2" }, d),
  ]);
  assert(!r1.erreur && !r2.erreur, `${r1.texte} / ${r2.texte}`);
  assert(suivi.maxParSession.get("cse_a") === 1, "jamais deux échanges à la fois sur la même session");
  assert(suivi.ordre.join(",") === "debut-1,fin-1,debut-2,fin-2", suivi.ordre.join(","));
  assert(r1.texte.startsWith("réponse-1") && r2.texte.startsWith("réponse-2"), "chaque appel lit sa propre réponse");
});

await lancer("T-180 : sessions différentes en parallèle ; un échec libère le verrou", async () => {
  const { query, suivi } = fauxQueryCompteur();
  const d = deps(fauxFetch(tableDeuxSessions()).fn, query);
  const [ra, rb] = await Promise.all([
    demanderASession({ session: "Bureau", message: "pour-a" }, d),
    demanderASession({ session: "Autre", message: "pour-b" }, d),
  ]);
  assert(!ra.erreur && !rb.erreur, `${ra.texte} / ${rb.texte}`);
  assert(suivi.maxGlobal === 2, `les deux sessions tournent ensemble (max ${suivi.maxGlobal})`);
  // Un échange en échec (flux fermé sans réponse) ne bloque pas le suivant sur la même session.
  const dEchec = deps(fauxFetch(tableDeuxSessions()).fn, fauxQuery({ messages: [] }).query);
  const [e1, e2] = await Promise.all([
    demanderASession({ session: "cse_a", message: "m" }, dEchec),
    demanderASession({ session: "cse_a", message: "m" }, dEchec),
  ]);
  assert(e1.erreur && e2.erreur && e2.texte.includes("sans rendre de réponse"), "le second passe quand même, avec sa propre erreur");
  const apres = await demanderASession({ session: "cse_a", message: "pour-a" }, d);
  assert(!apres.erreur, "verrou libéré");
});
