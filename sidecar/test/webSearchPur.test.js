/*
 * Fonctions pures de la recherche web (sidecar/src/webSearch.ts, spec R9 §7).
 *
 * Trois familles, et une seule compte vraiment :
 *   - la GARDE d'URL, qui empêche d'aller chercher une page du réseau privé
 *     du poste parce qu'un moteur l'a citée. Un défaut là n'est pas un bug
 *     d'affichage, c'est une SSRF ;
 *   - l'extraction et la troncature, où un motif mal écrit part en
 *     backtracking sur une page réelle de plusieurs centaines de kilo-octets ;
 *   - les blocs d'honnêteté, qui garantissent qu'une recherche en panne ne se
 *     transforme jamais en réponse de mémoire présentée comme fraîche (T-010).
 *
 * Aucun accès réseau : tout est pur, ou injecté.
 *
 * Lancement isolé : node sidecar/test/webSearchPur.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const {
  adresseInterdite,
  urlAutorisee,
  extraireTexte,
  tronquer,
  construireBloc,
  preparerContexteWeb,
  setWebSearchConfig,
  getWebSearchConfig,
  DEFAULT_SEARXNG_URL,
  BLOC_VIDE,
} = await import(moduleCompile("webSearch.js"));

async function testGardeUrl() {
  // Schémas : seuls http/https peuvent être suivis.
  for (const mauvais of ["file:///etc/passwd", "ftp://exemple.fr/x", "data:text/html,<b>x", "javascript:alert(1)"]) {
    assert(urlAutorisee(mauvais).ok === false, `schéma refusé : ${mauvais}`);
  }
  assert(urlAutorisee("https://a.exemple.fr/a").ok === true, "https public accepté");
  assert(urlAutorisee("http://a.exemple.fr/a").ok === true, "http public accepté");

  // Hôtes locaux, sous toutes leurs écritures.
  for (const local of [
    "http://localhost/x",
    "http://api.localhost/x",
    "http://nas.local/x",
    "http://127.0.0.1:8081/search",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // audit-publication:ok — métadonnées cloud, la cible classique d'une SSRF
    "http://[::1]/x",
  ]) {
    assert(urlAutorisee(local).ok === false, `adresse locale refusée : ${local}`);
  }

  // Ce qui RESSEMBLE à du privé sans l'être ne doit pas être refusé à tort.
  // audit-publication:ok — vecteurs de test de la garde, aucune machine réelle visée.
  assert(urlAutorisee("http://172.32.0.1/").ok === true, "172.32 est public (hors 16-31)"); // audit-publication:ok
  assert(urlAutorisee("http://11.0.0.1/").ok === true, "11.x est public"); // audit-publication:ok
  assert(urlAutorisee("http://192.169.1.1/").ok === true, "192.169 est public"); // audit-publication:ok

  assert(adresseInterdite("::ffff:127.0.0.1") === true, "IPv4 mappée en IPv6 démasquée");
  assert(adresseInterdite("8.8.8.8") === false, "adresse publique autorisée"); // audit-publication:ok

  assert(urlAutorisee("pas une url").ok === false, "URL illisible refusée sans exception");
  console.log("OK: garde d'URL — schémas, plages privées, faux positifs");
}

async function testExtraction() {
  const html = `<html><head><style>body{color:red}</style>
    <script>var secret = "ne doit pas fuir";</script></head>
    <body><h1>Titre &amp; suite</h1><p>Premier</p><p>Second&nbsp;bloc</p>
    <div>caf&#233;</div><span>&#x41;</span></body></html>`;
  const texte = extraireTexte(html);

  assert(!texte.includes("secret"), "le contenu de <script> part avec la balise");
  assert(!texte.includes("color:red"), "le contenu de <style> part avec la balise");
  assert(texte.includes("Titre & suite"), "entité nommée décodée");
  assert(texte.includes("café"), "entité numérique décimale décodée");
  assert(texte.includes("A"), "entité numérique hexadécimale décodée");
  assert(!texte.includes("<"), "aucune balise résiduelle");
  assert(!/\n{3,}/.test(texte), "les lignes vides sont réduites");

  // Une entité inconnue reste telle quelle plutôt que de disparaître.
  assert(extraireTexte("<p>&inconnue; fin</p>").includes("&inconnue;"), "entité inconnue préservée");

  // Robustesse : une page bavarde ne doit pas faire exploser le temps de calcul.
  const gros = `<div>${"mot ".repeat(200000)}</div>`;
  const debut = Date.now();
  extraireTexte(gros);
  assert(Date.now() - debut < 3000, "extraction linéaire sur une grosse page (pas de backtracking)");
  console.log("OK: extraction — balises, entités, blancs, tenue en charge");
}

async function testTroncature() {
  assert(tronquer("court", 100) === "court", "sous la limite : texte intact");
  const coupe = tronquer("a".repeat(50) + " " + "b".repeat(50), 60);
  assert(coupe.length < 120 && coupe.includes("[…tronqué]"), "au-delà : tronqué ET signalé");
  console.log("OK: troncature — bornée et annoncée");
}

async function testBloc() {
  const bloc = construireBloc(
    [
      { titre: "Titre A", url: "https://a.exemple.fr", date: "2026-08-10", texte: "texte A" },
      { titre: "Titre B", url: "https://b.exemple.fr", texte: "texte B" },
    ],
    "2026-08-10",
  );
  assert(bloc.includes("[1] Titre A — https://a.exemple.fr (2026-08-10)"), "source 1 numérotée, datée, sourcée");
  assert(bloc.includes("[2] Titre B — https://b.exemple.fr\n"), "source 2 sans date");
  assert(bloc.includes("[1]") && bloc.includes("N'invente aucune source"), "consigne de citation présente");
  console.log("OK: bloc injecté — numérotation et consigne");
}

async function testConfigSouple() {
  setWebSearchConfig({ baseUrl: "http://searx.local:9999/" });
  assert(getWebSearchConfig().baseUrl === "http://searx.local:9999", "URL retenue, slash final retiré");
  for (const mauvais of [undefined, null, {}, { baseUrl: "" }, { baseUrl: 42 }, { baseUrl: "ftp://x" }]) {
    setWebSearchConfig(mauvais);
    assert(getWebSearchConfig().baseUrl === DEFAULT_SEARXNG_URL, `config invalide → défaut (${JSON.stringify(mauvais)})`);
  }
  console.log("OK: config du moteur — validation souple, jamais d'erreur");
}

async function testHonnetete() {
  // Moteur en panne : le tour n'est PAS perdu, mais le modèle reçoit l'ordre de le dire.
  const enPanne = { rechercher: async () => { throw new Error("connexion refusée"); } };
  const echec = await preparerContexteWeb("actus", { moteur: enPanne, dateISO: "2026-08-10" });
  assert(echec.etat === "echec", "moteur en panne → etat echec");
  assert(echec.sources.length === 0, "aucune source inventée");
  assert(echec.bloc.includes("Dis-le explicitement"), "le bloc ORDONNE de signaler l'échec");
  assert(echec.message.includes("connexion refusée"), "la cause est remontée");

  // Zéro résultat : même exigence.
  const vide = { rechercher: async () => [] };
  const rienTrouve = await preparerContexteWeb("actus", { moteur: vide, dateISO: "2026-08-10" });
  assert(rienTrouve.etat === "vide" && rienTrouve.bloc === BLOC_VIDE, "zéro résultat → bloc d'honnêteté");

  // Question vide : pas de recherche du tout (l'appelant ne doit pas l'invoquer,
  // mais le module ne doit pas non plus interroger le moteur pour rien).
  console.log("OK: honnêteté — échec et vide ne deviennent jamais une réponse de mémoire");
}

async function testCheminNominal() {
  const moteur = {
    rechercher: async (q, n) => {
      assert(q === "actualités" && n === 5, "la question part telle quelle, 5 résultats demandés");
      return [
        { titre: "A", url: "https://a.exemple.fr", extrait: "extrait A", date: "2026-08-09" },
        { titre: "B", url: "https://b.exemple.fr", extrait: "extrait B" },
      ];
    },
  };
  // Une page se récupère, l'autre échoue : l'échec doit être SAUTÉ, pas fatal.
  const recuperer = async (url) => (url === "https://a.exemple.fr" ? "texte complet de A" : null);

  const ctx = await preparerContexteWeb("actualités", { moteur, recuperer, dateISO: "2026-08-10" });
  assert(ctx.etat === "ok", "etat ok");
  assert(ctx.sources.length === 2, "les DEUX sources sont citables, même celle non récupérée");
  assert(ctx.sources[0].n === 1 && ctx.sources[1].n === 2, "numérotation à partir de 1");
  assert(ctx.bloc.includes("texte complet de A"), "page récupérée : son texte est injecté");
  assert(ctx.bloc.includes("extrait B"), "page en échec : repli sur l'extrait du moteur");

  // Sans classeur d'embeddings (Ollama arrêté), on dégrade sans casser.
  const classeurEnPanne = async () => { throw new Error("ollama arrêté"); };
  const degrade = await preparerContexteWeb("actualités", {
    moteur, recuperer, classer: classeurEnPanne, dateISO: "2026-08-10",
  });
  assert(degrade.etat === "ok" && degrade.bloc.includes("texte complet de A"),
    "embeddings en panne → repli sur le texte brut, jamais d'échec du tour");
  console.log("OK: chemin nominal — page sautée, repli, dégradation sans casse");
}

await lancer(
  "recherche web — gardes et honnêteté",
  testGardeUrl,
  testExtraction,
  testTroncature,
  testBloc,
  testConfigSouple,
  testHonnetete,
  testCheminNominal,
);
