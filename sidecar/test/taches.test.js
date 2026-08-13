/*
 * tâches — champ lieu
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/taches.test.js
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, moduleCompile } from "./harness.mjs";

/**
 * T1 — champ `lieu` du manifeste `tache.yaml` (docs/protocol.md § « Méthodes
 * T1 », docs/etude-remote.md § 3 bis). En-process (import direct de
 * dist/taches.js) : ces handlers ne font que du disque, un sous-processus
 * sidecar n'apporterait rien. `XDG_CONFIG_HOME` est relu à chaque appel côté
 * module, donc l'override in-process suffit.
 *
 * Le cas capital est l'ALLER-RETOUR par le chemin structuré
 * (`taches.write {tache}`), qui ré-sérialise le manifeste depuis l'objet
 * normalisé : c'est là qu'un champ non first-class disparaît en silence, et
 * avec lui le garde-fou anti-double-déclenchement.
 */
async function testTachesLieu() {
  const tachesModuleUrl = moduleCompile("taches.js");
  const { handleTachesWrite, handleTachesRead, handleTachesList } = await import(tachesModuleUrl);

  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-taches-lieu-"));
  process.env.XDG_CONFIG_HOME = xdgDir;

  // Émetteur jetable : capture l'unique done/error du handler appelé.
  function callHandler(handler, params) {
    let captured = null;
    const emitter = {
      chunk() {},
      done(_id, data) {
        captured = { kind: "done", data };
      },
      error(_id, message) {
        captured = { kind: "error", message };
      },
    };
    return handler("t-lieu", params, emitter).then(() => captured);
  }

  const tacheDir = (name) => path.join(xdgDir, "net.duvam.iaction", "taches", name);

  try {
    // 1. `lieu` absent -> défaut "local" (mode raw, manifeste minimal).
    const w1 = await callHandler(handleTachesWrite, {
      name: "sans-lieu",
      raw: "name: sans-lieu\norchestration: veille\n",
    });
    assert(w1.kind === "done", `write sans-lieu attendu 'done', reçu ${JSON.stringify(w1)}`);
    assert(w1.data.tache.lieu === "local", `lieu absent doit valoir 'local', reçu ${JSON.stringify(w1.data.tache.lieu)}`);

    // 2. `lieu: serveur` accepté tel quel.
    const w2 = await callHandler(handleTachesWrite, {
      name: "temoin-serveur",
      raw: "name: temoin-serveur\norchestration: temoin\nlieu: serveur\n",
    });
    assert(w2.kind === "done", `write temoin-serveur attendu 'done', reçu ${JSON.stringify(w2)}`);
    assert(w2.data.tache.lieu === "serveur", `lieu 'serveur' doit être conservé, reçu ${JSON.stringify(w2.data.tache.lieu)}`);

    // 3. Valeurs invalides : REFUSÉES bruyamment, jamais ramenées à 'local'.
    //    Fautes de frappe plausibles comprises (espace final, anglais, casse).
    for (const mauvais of ["serveur ", "server", "Serveur", "distant", "42"]) {
      const wBad = await callHandler(handleTachesWrite, {
        name: "lieu-invalide",
        raw: `name: lieu-invalide\norchestration: veille\nlieu: ${JSON.stringify(mauvais)}\n`,
      });
      assert(
        wBad.kind === "error" && wBad.message.includes("'lieu'") && wBad.message.includes(mauvais),
        `lieu ${JSON.stringify(mauvais)} doit être refusé avec la valeur citée, reçu ${JSON.stringify(wBad)}`,
      );
    }
    // …et rien n'a été écrit sur disque au passage.
    const ecrit = await fsp
      .access(path.join(tacheDir("lieu-invalide"), "tache.yaml"))
      .then(() => true)
      .catch(() => false);
    assert(!ecrit, "un manifeste au 'lieu' invalide ne doit pas être écrit");

    // 4. ALLER-RETOUR par le chemin structuré (`params.tache`) — le bug que ce
    //    test verrouille : le formulaire de l'UI emprunte CE chemin, qui
    //    ré-sérialise depuis l'objet normalisé.
    const lu = await callHandler(handleTachesRead, { name: "temoin-serveur" });
    assert(lu.kind === "done", `read temoin-serveur attendu 'done', reçu ${JSON.stringify(lu)}`);
    assert(lu.data.tache.lieu === "serveur", `read : lieu 'serveur' attendu, reçu ${JSON.stringify(lu.data.tache.lieu)}`);

    // Ré-écriture façon formulaire : on ne touche QUE la description.
    const modifie = { ...lu.data.tache, description: "Éditée depuis le formulaire." };
    delete modifie.path;
    const w3 = await callHandler(handleTachesWrite, { tache: modifie });
    assert(w3.kind === "done", `write structuré attendu 'done', reçu ${JSON.stringify(w3)}`);
    assert(
      w3.data.tache.lieu === "serveur",
      `write structuré : lieu 'serveur' doit survivre à la ré-sérialisation, reçu ${JSON.stringify(w3.data.tache.lieu)}`,
    );

    const relu = await callHandler(handleTachesRead, { name: "temoin-serveur" });
    assert(
      relu.kind === "done" && relu.data.tache.lieu === "serveur",
      `relecture après écriture structurée : 'serveur' attendu, reçu ${JSON.stringify(relu.data?.tache)}`,
    );
    assert(
      /^lieu: serveur$/m.test(relu.data.raw),
      `le YAML écrit doit porter 'lieu: serveur', reçu:\n${relu.data.raw}`,
    );

    // 5. taches.list expose aussi le lieu (l'UI en dépend pour son badge).
    const liste = await callHandler(handleTachesList, {});
    assert(liste.kind === "done", `list attendu 'done', reçu ${JSON.stringify(liste)}`);
    const parNom = Object.fromEntries(liste.data.taches.map((t) => [t.name, t]));
    assert(
      parNom["temoin-serveur"]?.lieu === "serveur" && parNom["sans-lieu"]?.lieu === "local",
      `list : lieux incorrects, reçu ${JSON.stringify(liste.data.taches.map((t) => [t.name, t.lieu]))}`,
    );

    // 6. Manifeste illisible : entrée 'invalid' repliée sur 'local' (jamais
    //    présentée comme armée côté serveur).
    await fsp.mkdir(tacheDir("cassee"), { recursive: true });
    await fsp.writeFile(path.join(tacheDir("cassee"), "tache.yaml"), "name: cassee\nlieu: n'importe quoi\n", "utf8");
    const liste2 = await callHandler(handleTachesList, {});
    const cassee = liste2.data.taches.find((t) => t.name === "cassee");
    assert(
      cassee && typeof cassee.invalid === "string" && cassee.lieu === "local",
      `list : entrée invalide attendue avec lieu 'local', reçu ${JSON.stringify(cassee)}`,
    );
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log("OK: T1 — champ 'lieu' des tâches (défaut, validation, aller-retour)");
}

await lancer(
  "tâches — champ lieu",
  testTachesLieu,
);
