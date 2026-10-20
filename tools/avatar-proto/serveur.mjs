#!/usr/bin/env node
/*
 * Serveur local du prototype d'avatar : fichiers statiques + synthèse vocale.
 *
 * Pourquoi un serveur et pas la voix du navigateur : sur ce poste,
 * speechSynthesis est MUETTE (aucune voix française, vécu le 07/10) et ne
 * donne de toute façon pas accès au son, donc la bouche ne pouvait que
 * mimer. Ici on synthétise avec le MÊME moteur et la MÊME voix qu'IAction
 * (Kokoro 82M q8, voix ff_siwis — voir loadKokoro dans sidecar/src/speech.ts),
 * et la page reçoit un vrai WAV qu'elle analyse pour animer la bouche.
 *
 * Reprend de loadKokoro les deux contournements indispensables :
 *   - le cache du modèle se règle sur la copie de transformers.js
 *     EMBARQUÉE par kokoro-js (pas la nôtre) ;
 *   - la validation de voix de kokoro-js 1.2.1 rejette ff_siwis : on la
 *     remplace par une validation de forme.
 *
 * Lancer : node tools/avatar-proto/serveur.mjs   puis http://localhost:8765
 * Écoute sur 127.0.0.1 seulement : rien n'est exposé au réseau.
 */
import http from "node:http";
import { promises as fsp, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8765);
const VOIX = process.env.VOIX ?? "ff_siwis";
const MODELE = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Cache des modèles d'IAction ; l'ancien nom (ia-studio) s'il est le seul peuplé. */
function dossierCache() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const actuel = path.join(base, "iaction", "models");
  const ancien = path.join(base, "ia-studio", "models");
  return existsSync(path.join(actuel, MODELE)) || !existsSync(path.join(ancien, MODELE)) ? actuel : ancien;
}

let kokoro = null;
function chargerKokoro() {
  kokoro ??= (async () => {
    const require = createRequire(import.meta.url);
    const entree = require.resolve("kokoro-js");
    const imbrique = createRequire(entree).resolve("@huggingface/transformers").replace(/\.cjs$/, ".mjs");
    const { env } = await import(pathToFileURL(imbrique).href);
    env.cacheDir = dossierCache();
    const { KokoroTTS } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained(MODELE, { dtype: "q8" });
    tts._validate_voice = (v) => {
      if (!/^[a-z]{2}_[a-z0-9]+$/.test(v)) throw new Error(`voix invalide : ${v}`);
      return v[0];
    };
    console.log(`Kokoro prêt (cache ${env.cacheDir}, voix ${VOIX})`);
    return tts;
  })();
  return kokoro;
}

/** Float32 mono → WAV PCM 16 bits (ce que decodeAudioData lit partout). */
function enWav(audio, frequence) {
  const donnees = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    donnees.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767), i * 2);
  }
  const entete = Buffer.alloc(44);
  entete.write("RIFF", 0); entete.writeUInt32LE(36 + donnees.length, 4); entete.write("WAVE", 8);
  entete.write("fmt ", 12); entete.writeUInt32LE(16, 16); entete.writeUInt16LE(1, 20);
  entete.writeUInt16LE(1, 22); entete.writeUInt32LE(frequence, 24);
  entete.writeUInt32LE(frequence * 2, 28); entete.writeUInt16LE(2, 32); entete.writeUInt16LE(16, 34);
  entete.write("data", 36); entete.writeUInt32LE(donnees.length, 40);
  return Buffer.concat([entete, donnees]);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".glb": "model/gltf-binary", ".css": "text/css" };

http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/tts") {
      let corps = "";
      for await (const morceau of req) corps += morceau;
      const { texte } = JSON.parse(corps);
      const t0 = Date.now();
      const { audio, sampling_rate } = await (await chargerKokoro()).generate(texte, { voice: VOIX, speed: 1.0 });
      console.log(`tts ${Date.now() - t0} ms : ${texte.slice(0, 50)}`);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      return res.end(enWav(audio, sampling_rate));
    }
    // Statique, confiné au dossier du prototype (pas de « ../ »).
    const chemin = path.normalize(path.join(ICI, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (chemin !== ICI && !chemin.startsWith(ICI + path.sep)) { res.writeHead(403); return res.end(); }
    const fichier = chemin.endsWith(path.sep) ? path.join(chemin, "index.html") : chemin;
    const contenu = await fsp.readFile(fichier);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fichier)] ?? "application/octet-stream" });
    res.end(contenu);
  } catch (err) {
    const introuvable = err.code === "ENOENT";
    if (!introuvable) console.error(err);
    res.writeHead(introuvable ? 404 : 500);
    res.end(introuvable ? "introuvable" : "erreur interne"); // le détail reste dans la console, jamais chez le client
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Avatar : http://localhost:${PORT}`);
  chargerKokoro().catch((e) => console.error("Kokoro indisponible :", e.message));  // préchauffe
});
