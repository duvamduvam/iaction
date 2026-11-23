/*
 * Service du veilleur (veilleurService.ts) — états et transitions, battement
 * qui saute pendant une relève, arrêt qui interrompt, redémarrage au
 * lancement, et le jeton jamais au journal ni au statut. Tout injecté.
 *
 * Lancement isolé : node sidecar/test/veilleurService.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { creerServiceVeilleur } = await import(moduleCompile("veilleurService.js"));
const { creerEtatFichier } = await import(moduleCompile("veilleurEtat.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const JETON = "JETON-TRES-SECRET-0123456789";
const config = {
  actif: true,
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
const vide = { traites: [], refuses: [], ignores: [], invalides: [] };

async function monter(over = {}) {
  const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-service-"));
  const lignes = [];
  const statuts = [];
  const repetitions = [];
  const env = {
    coffre: "ouvert",
    secrets: { "relais.jeton": JETON },
    config: { config },
    releves: 0,
    clientsCrees: [],
    /** Le scellé au coffre : par défaut, toute config est approuvée. */
    scelle: () => true,
  };
  const service = creerServiceVeilleur({
    dossier,
    lireConfig: async () => env.config,
    etatCoffre: () => env.coffre,
    secrets: async () => env.secrets,
    scelle: (nom, h) => env.scelle(nom, h),
    client: (c, jeton) => (env.clientsCrees.push({ c, jeton }), { faux: true }),
    lanceur: () => async () => ({ corps: "ok", coutUsd: 0 }),
    releve: over.releve ?? (async () => ((env.releves += 1), vide)),
    repeter: (fn, ms) => (repetitions.push({ fn, ms }), () => {}),
    notifier: (s) => statuts.push(s),
    journal: (niveau, message, champs) => lignes.push({ niveau, message, champs }),
    ...over.deps,
  });
  return { service, env, lignes, statuts, repetitions, dossier };
}
const attendre = () => new Promise((r) => setTimeout(r, 20));

await cas("actif : relève avec le client du coffre, cadence de la config", async () => {
  const { service, env, repetitions } = await monter();
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "actif" && s.cwd === "/projet", `actif (reçu ${s.etat})`);
  assert(env.releves === 1, "une relève au démarrage");
  assert(env.clientsCrees[0].jeton === JETON, "jeton passé au client");
  assert(repetitions.some((r) => r.ms === 30_000), "cadence 30 s");
  assert(s.derniereReleve !== undefined, "date de relève");
});

await cas("coffre fermé : en-attente-coffre, journal une fois par transition", async () => {
  const { service, env, lignes } = await monter();
  env.coffre = "verrouille";
  await service.demarrer("/projet");
  await attendre();
  await service.battement();
  await service.battement();
  assert((await service.statut()).etat === "en-attente-coffre", "en attente");
  assert(env.releves === 0, "aucune relève");
  assert(lignes.filter((l) => l.message === "veilleur : en-attente-coffre").length === 1, "une seule ligne");
  env.coffre = "ouvert";
  await service.battement();
  assert((await service.statut()).etat === "actif" && env.releves === 1, "reprend à l'ouverture");
});

await cas("jeton absent : invalide, motif clair, jamais de valeur", async () => {
  const { service, env } = await monter();
  env.secrets = {};
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "invalide" && s.motif.includes("relais.jeton"), `invalide (reçu ${s.motif})`);
});

await cas("config invalide ou désactivée", async () => {
  const { service, env } = await monter();
  env.config = { invalide: "« url » : https:// attendu" };
  await service.demarrer("/projet");
  await attendre();
  assert((await service.statut()).etat === "invalide", "invalide");
  env.config = { config: { ...config, actif: false } };
  await service.battement();
  assert((await service.statut()).etat === "inactif", "désactivé dans la config");
});

await cas("une relève en cours fait sauter le battement", async () => {
  let liberer;
  let appels = 0;
  const { service } = await monter({
    releve: async () => {
      appels += 1;
      await new Promise((r) => (liberer = r));
      return vide;
    },
  });
  await service.demarrer("/projet");
  await attendre();
  await Promise.race([service.battement(), attendre()]);
  assert(appels === 1, `une seule relève à la fois (reçu ${appels})`);
  assert((await service.statut()).enCours === true, "en cours");
  liberer();
  await attendre();
});

await cas("arrêter : le signal de la relève est levé, état inactif", async () => {
  let signalVu;
  let liberer;
  const { service } = await monter({
    releve: async (deps) => {
      signalVu = deps.signal;
      await new Promise((r) => {
        liberer = r;
        deps.signal.addEventListener("abort", () => r());
      });
      return vide;
    },
  });
  await service.demarrer("/projet");
  await attendre();
  const s = await service.arreter();
  assert(signalVu.aborted, "signal levé : le tour s'interrompt");
  assert(s.etat === "arret-en-cours" || s.etat === "inactif", `arrêt en cours ou fini (reçu ${s.etat})`);
  liberer?.();
  await attendre();
  assert((await service.statut()).etat === "inactif", "inactif une fois la relève rendue");
});

await cas("tour qui ne rend pas la main : « arret-en-cours », jamais « inactif », jusqu'à sa fin", async () => {
  let liberer;
  const { service } = await monter({ releve: () => new Promise((r) => (liberer = () => r(vide))) });
  await service.demarrer("/projet");
  await attendre();
  const s = await service.arreter();
  assert(s.etat === "arret-en-cours" && s.enCours, `arret-en-cours (reçu ${s.etat})`);
  await attendre();
  assert((await service.statut()).etat === "arret-en-cours", "toujours, tant que le tour vit");
  await service.battement();
  liberer();
  await attendre();
  assert((await service.statut()).etat === "inactif", "inactif après la fin réelle");
});

await cas("scellé : config non approuvée ⇒ invalide, AUCUN client créé (aucune requête)", async () => {
  const { service, env } = await monter();
  const vus = [];
  env.scelle = (nom, h) => (vus.push({ nom, h }), false);
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "invalide" && s.motif.includes("ré-enregistre-la"), `invalide (reçu ${s.motif})`);
  assert(env.clientsCrees.length === 0 && env.releves === 0, "aucun client, aucune relève");
  assert(/^[0-9a-f]{64}$/.test(vus[0].h), "empreinte calculée sur la config relue");
  assert(/^veilleur\.empreinte\.[0-9a-f]{8}$/.test(vus[0].nom), `scellé PAR PROJET (reçu ${vus[0].nom})`);
});

await cas("scellé de l'ancienne forme (« veilleur.empreinte » sans projet) : ignoré", async () => {
  const { service, env } = await monter();
  const { scellePour } = await import(moduleCompile("veilleurConfig.js"));
  const { empreinte } = await scellePour("/projet", config);
  const table = { "veilleur.empreinte": empreinte };
  env.scelle = (nom, h) => table[nom] === h;
  await service.demarrer("/projet");
  await attendre();
  assert((await service.statut()).etat === "invalide" && env.clientsCrees.length === 0, "non reconnu");
});

await cas("scellé : config modifiée après approbation ⇒ invalide au battement suivant", async () => {
  const { service, env } = await monter();
  let approuvee = null;
  env.scelle = (_nom, h) => {
    approuvee ??= h; // la première config relue est celle approuvée
    return h === approuvee;
  };
  await service.demarrer("/projet");
  await attendre();
  assert((await service.statut()).etat === "actif" && env.releves === 1, "approuvée : actif");
  env.config = { config: { ...config, url: "https://ailleurs.example.net" } };
  await service.battement();
  const s = await service.statut();
  assert(s.etat === "invalide" && env.releves === 1 && env.clientsCrees.length === 1, "plus aucune relève, aucun nouveau client");
});

await cas("liste en échec : invalide avec le motif, retour à actif dès qu'elle réussit, journal à la transition", async () => {
  let echoue = true;
  const { service, lignes } = await monter({ releve: async () => (echoue ? { ...vide, erreur: "lecture de la boîte impossible : 401" } : vide) });
  await service.demarrer("/projet");
  await attendre();
  await service.battement();
  await service.battement();
  const s = await service.statut();
  assert(s.etat === "invalide" && s.motif.includes("401"), `invalide (reçu ${s.motif})`);
  assert(lignes.filter((l) => l.message === "veilleur : invalide").length === 1, "une seule ligne");
  echoue = false;
  await service.battement();
  assert((await service.statut()).etat === "actif", "retour à actif");
});

await cas("état illisible : invalide, aucune relève", async () => {
  const { service, env } = await monter({
    deps: {
      creerEtat: () => {
        const ko = async () => {
          throw new Error("état du veilleur corrompu (etat.json)");
        };
        return { idsTraites: ko, statutDe: ko, marquerEnCours: ko, preparerReponse: ko, marquerRepondu: ko, enCours: ko, toursAujourdhui: ko, incrementerTour: ko, suspension: ko, suspendre: ko, lever: ko };
      },
    },
  });
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "invalide" && s.motif.includes("corrompu") && env.releves === 0, `invalide (reçu ${s.motif})`);
});

await cas("poste.json corrompu au lancement : invalide, pas d'état neuf inventé", async () => {
  const a = await monter();
  await fsp.writeFile(path.join(a.dossier, "poste.json"), "{pas du json");
  await a.service.demarrerAuLancement();
  const s = await a.service.statut();
  assert(s.etat === "invalide" && s.motif.includes("poste.json"), `invalide (reçu ${s.motif})`);
});

await cas("arrêt pendant la lecture de la config : aucune relève ne part ensuite", async () => {
  let rendre;
  const { service, env } = await monter({
    deps: { lireConfig: () => new Promise((r) => (rendre = () => r({ config }))) },
  });
  await service.demarrer("/projet");
  const arret = service.arreter();
  rendre();
  await arret;
  await attendre();
  assert(env.releves === 0, `aucune relève après l'arrêt (reçu ${env.releves})`);
  assert((await service.statut()).etat === "inactif", "inactif");
});

await cas("arrêt pendant la lecture des secrets : aucune relève ne part avec un signal neuf", async () => {
  let rendre;
  const { service, env } = await monter({
    deps: { secrets: () => new Promise((r) => (rendre = () => r({ "relais.jeton": JETON }))) },
  });
  await service.demarrer("/projet");
  await attendre();
  const arret = service.arreter();
  rendre();
  await arret;
  await attendre();
  await service.battement(); // après l'arrêt : aucun battement ne repart
  assert(env.releves === 0, `aucune relève (reçu ${env.releves})`);
  assert((await service.statut()).etat === "inactif", "inactif");
});

await cas("tour bloqué après interruption : état « bloque » visible, plus aucune relève, même après sa fin", async () => {
  let relevees = 0;
  const { service } = await monter({
    releve: async (deps) => {
      relevees += 1;
      await deps.lancer({ fil: "f", id: "m", type: "demande", profondeur: 0, corps: "x" }, "maison", { pieces: { ecrites: [], refusees: [] } });
      return vide;
    },
    deps: { lanceur: (_c, _cfg, _j, _f, surBlocage) => async () => (surBlocage("tour interrompu mais toujours vivant après 60 s : relance l'application"), { corps: "x", coutUsd: 0 }) },
  });
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "bloque" && s.motif.includes("relance l'application"), `bloque (reçu ${s.etat})`);
  await service.battement();
  assert(relevees === 1, "aucune nouvelle relève");
  assert((await service.statut()).etat === "bloque", "toujours bloqué");
});

await cas("sortie du sidecar : arrêt, tour interrompu, attente bornée", async () => {
  const a = await monter({ releve: (deps) => new Promise((r) => deps.signal.addEventListener("abort", () => r(vide))) });
  await a.service.demarrer("/projet");
  await attendre();
  assert((await a.service.arreterPourSortir(1000)) === true, "le tour rend la main");
  const b = await monter({ releve: () => new Promise(() => {}) });
  await b.service.demarrer("/projet");
  await attendre();
  const debut = Date.now();
  assert((await b.service.arreterPourSortir(50)) === false && Date.now() - debut < 1000, "borné même si le tour ne rend jamais la main");
});

await cas("suspension : plus de relève jusqu'à lever()", async () => {
  const { service, env, dossier } = await monter();
  await creerEtatFichier(path.join(dossier, "etat.json")).suspendre("coût du tour 7.50 $");
  await service.demarrer("/projet");
  await attendre();
  const s = await service.statut();
  assert(s.etat === "suspendu" && s.motif.includes("7.50"), `suspendu (reçu ${s.etat})`);
  assert(env.releves === 0, "aucune relève");
  await service.lever();
  await service.battement();
  assert((await service.statut()).etat === "actif" && env.releves === 1, "repart après lever");
});

await cas("bilan suspendu pendant la relève : état suspendu", async () => {
  const { service, dossier } = await monter({
    releve: async (deps) => {
      await deps.etat.suspendre("coût 9 $");
      return { ...vide, traites: ["m1"], suspendu: true };
    },
  });
  await service.demarrer("/projet");
  await attendre();
  assert((await service.statut()).etat === "suspendu", "suspendu");
  assert(dossier, "dossier");
});

await cas("redémarrage au lancement : seulement si poste.json et config active", async () => {
  const a = await monter();
  await a.service.demarrerAuLancement();
  assert((await a.service.statut()).etat === "inactif", "sans poste.json : rien");
  await fsp.writeFile(path.join(a.dossier, "poste.json"), JSON.stringify({ cwd: "/projet" }));
  const b = await monter({ deps: { dossier: a.dossier } });
  await b.service.demarrerAuLancement();
  await attendre();
  assert((await b.service.statut()).etat === "actif" && b.env.releves === 1, "redémarré");
  const c = await monter({ deps: { dossier: a.dossier, lireConfig: async () => ({ config: { ...config, actif: false } }) } });
  await c.service.demarrerAuLancement();
  assert((await c.service.statut()).etat === "inactif", "config inactive : pas de démarrage");
});

await cas("transitions poussées à l'interface ; jeton jamais au journal ni au statut", async () => {
  const { service, env, lignes, statuts } = await monter();
  await service.demarrer("/projet");
  await attendre();
  env.coffre = "verrouille";
  await service.battement();
  await service.arreter();
  const etats = statuts.map((s) => s.etat);
  assert(etats.includes("actif") && etats.includes("en-attente-coffre") && etats.includes("inactif"), `poussés (reçu ${etats})`);
  const tout = JSON.stringify(lignes) + JSON.stringify(statuts);
  assert(!tout.includes(JETON), "aucune trace du jeton");
});

await cas("poste.json écrit hors projet, atomique", async () => {
  const { service, dossier } = await monter();
  await service.demarrer("/projet");
  const poste = JSON.parse(await fsp.readFile(path.join(dossier, "poste.json"), "utf8"));
  assert(poste.cwd === "/projet", "poste mémorisé");
  assert((await fsp.readdir(dossier)).every((f) => !f.endsWith(".tmp")), "pas de temporaire");
  await service.arreter();
});

console.log(`veilleurService : ${ok} cas OK`);
