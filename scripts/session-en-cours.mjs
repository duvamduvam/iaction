#!/usr/bin/env node
/**
 * Refuse la vérification tant qu'une session de développement tourne (T-111).
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Le 2026-08-30, `npm run verif` a été lancée pendant qu'une session `dev.sh`
 * tournait, application ouverte et en cours d'utilisation. La vérification est
 * passée — code de sortie 0 — et à sa fin PLUS AUCUN processus de
 * l'application n'existait : ni `tauri dev`, ni Vite, ni `iaction`, ni la
 * webview.
 *
 * La cause exacte n'est pas établie, et c'est justement le point : `verif`
 * compile du Rust dans `src-tauri/target`, que `tauri dev` utilise aussi pour
 * ses reconstructions à chaud, et elle écrit des fichiers dans le dépôt que
 * des surveillants observent. Deux chantiers dans la même pièce.
 *
 * ── Pourquoi un REFUS et pas un répertoire de compilation séparé ────────
 * C'était la première idée — supprimer la concurrence plutôt que l'annoncer.
 * Mesure faite avant de coder : `src-tauri/target` pèse **27 Go**. Un second
 * répertoire coûterait autant, plus une reconstruction complète à la première
 * vérification. Le remède était plus cher que le mal.
 *
 * Reste donc à le DIRE. Une vérification qui tue la session de travail est
 * acceptable si on l'a décidé ; elle ne l'est pas si on la découvre après. Le
 * refus arrive en TÊTE de la chaîne, avant les trois minutes de tests : un
 * garde-fou qui prévient après coup ne prévient de rien.
 *
 * ── L'échappatoire ──────────────────────────────────────────────────────
 * `IACTION_VERIF_FORCE=1` passe outre, en le disant. Le jour où T-112 aura
 * répondu (l'application journalise désormais ses arrêts et détecte les
 * arrêts brutaux au démarrage suivant), ce refus pourra être levé — ou
 * confirmé sur preuve.
 */

/** Adresse du serveur de développement — même sonde que `scripts/dev.sh`. */
export const PORT_DEV = 1420;

/**
 * Décide, à partir des deux seuls faits qui comptent. Séparé de la sonde
 * réseau pour être testable sans ouvrir de port : un garde-fou dont on ne peut
 * pas exercer la décision est un garde-fou qu'on n'ose pas modifier.
 *
 * @param {{sessionDetectee: boolean, force: boolean}} etat
 * @returns {{code: 0|1, message: string}}
 */
export function verdict({ sessionDetectee, force }) {
  if (!sessionDetectee) {
    return { code: 0, message: "Aucune session de développement en cours." };
  }
  if (force) {
    return {
      code: 0,
      message:
        "Une session de développement tourne, et IACTION_VERIF_FORCE=1 passe outre.\n" +
        "    L'application peut disparaître pendant la vérification (T-111).",
    };
  }
  return {
    code: 1,
    message:
      `Une session de développement écoute sur le port ${PORT_DEV}.\n\n` +
      "    La vérification compile du Rust dans le même répertoire que la session,\n" +
      "    et le 2026-08-30 l'application a disparu pendant qu'elle tournait (T-111).\n" +
      "    On ne la lance donc pas dans ton dos.\n\n" +
      "    Ferme l'application, ou assume le risque :\n\n" +
      "        IACTION_VERIF_FORCE=1 npm run verif\n",
  };
}

/** Sonde réseau, isolée : c'est la seule partie qui touche au monde. */
async function sessionDetectee(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const fin = (reponse) => {
      socket.destroy();
      resolve(reponse);
    };
    socket.once("connect", () => fin(true));
    socket.once("error", () => fin(false));
    socket.setTimeout(1000, () => fin(false));
  });
}

// Exécuté seulement en ligne de commande : importé par son test, il ne fait rien.
if (process.argv[1] && process.argv[1].endsWith("session-en-cours.mjs")) {
  const detectee = await sessionDetectee(PORT_DEV);
  const { code, message } = verdict({
    sessionDetectee: detectee,
    force: process.env.IACTION_VERIF_FORCE === "1",
  });
  if (code !== 0) {
    console.error(`\n==> Vérification REFUSÉE : ${message}`);
  } else if (detectee) {
    console.error(`==> ${message}`);
  }
  process.exit(code);
}
