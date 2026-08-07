// Tests du moteur parole (speech.ts) — JS pur, sans framework, sans réseau et
// sans téléchargement de modèle :
// 1. parseur/encodeur WAV : import direct de dist/speech.js (les imports des
//    bibliothèques d'inférence y sont paresseux, l'import du module est léger) ;
// 2. validation des params et « clé manquante en mode remote » : via le
//    protocole JSON Lines, en spawnant dist/index.js comme protocol.test.js.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");

function fail(message) {
  console.error(`ECHEC: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

// ---------------------------------------------------------------------------
// 1. Parseur / encodeur WAV (unitaire, en mémoire)
// ---------------------------------------------------------------------------

const speech = await import(pathToFileURL(path.join(__dirname, "..", "dist", "speech.js")).href);

// Sinusoïde 440 Hz, 0,25 s à 16 kHz.
const sampleRate = 16000;
const sampleCount = sampleRate / 4;
const samples = new Float32Array(sampleCount);
for (let i = 0; i < sampleCount; i++) {
  samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
}

const wav = speech.encodeWavPcm16(samples, sampleRate);
assert(wav.length === 44 + sampleCount * 2, `taille WAV inattendue: ${wav.length}`);

// Aller-retour encode → parse : mêmes échantillons à la quantification près.
const parsed = speech.parseWavPcm16Mono(wav);
assert(parsed.sampleRate === sampleRate, `sampleRate attendu ${sampleRate}, reçu ${parsed.sampleRate}`);
assert(parsed.samples.length === sampleCount, `nombre d'échantillons attendu ${sampleCount}, reçu ${parsed.samples.length}`);
for (let i = 0; i < sampleCount; i += 100) {
  const diff = Math.abs(parsed.samples[i] - samples[i]);
  assert(diff < 2 / 32768, `échantillon ${i} trop éloigné après aller-retour (écart ${diff})`);
}

function expectParseError(bytes, pattern, label) {
  try {
    speech.parseWavPcm16Mono(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(pattern.test(message), `${label}: message inattendu « ${message} »`);
    return;
  }
  fail(`${label}: aucune erreur levée`);
}

// Pas un WAV du tout.
expectParseError(
  new TextEncoder().encode("ceci n'est pas un fichier wav, vraiment pas du tout, promis juré"),
  /RIFF/,
  "en-tête invalide",
);

// Fichier trop court.
expectParseError(new Uint8Array(10), /trop court/, "fichier trop court");

// Stéréo refusé (mutation du champ channels, offset 22 du header canonique).
const stereo = wav.slice();
new DataView(stereo.buffer).setUint16(22, 2, true);
expectParseError(stereo, /mono/, "stéréo refusé");

// PCM 8 bits refusé (mutation de bitsPerSample, offset 34).
const eightBits = wav.slice();
new DataView(eightBits.buffer).setUint16(34, 8, true);
expectParseError(eightBits, /16 bits/, "8 bits refusé");

// Format non-PCM refusé (mutation d'audioFormat, offset 20 : 3 = IEEE float).
const floatFmt = wav.slice();
new DataView(floatFmt.buffer).setUint16(20, 3, true);
expectParseError(floatFmt, /PCM/, "format non-PCM refusé");

console.log("OK: parseur/encodeur WAV");

// ---------------------------------------------------------------------------
// 1 bis. Corps de /audio/speech et lisibilité des erreurs HTTP (unitaire)
// ---------------------------------------------------------------------------

// `response_format` est envoyé explicitement (le défaut de l'endpoint est
// "pcm", qu'on étiquetterait à tort audio/mpeg), `voice` est requis donc
// toujours présent, `speed` neutre (1) reste omis.
const bodyNeutral = speech.buildSpeechRequestBody(
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Zephyr", speed: 1 },
  "Bonjour !",
);
assert(bodyNeutral.model === "google/gemini-3.1-flash-tts-preview", "corps: model attendu");
assert(bodyNeutral.input === "Bonjour !", "corps: input attendu");
assert(bodyNeutral.voice === "Zephyr", "corps: voice attendu");
assert(bodyNeutral.response_format === "mp3", `corps: response_format attendu "mp3", reçu ${bodyNeutral.response_format}`);
assert(!("speed" in bodyNeutral), "corps: speed doit être omis quand il vaut 1");

// Voix vide : envoyée quand même (paramètre requis — au service de dire ce
// qu'il accepte), et vitesse non neutre transmise.
const bodySpeed = speech.buildSpeechRequestBody({ model: "hexgrad/kokoro-82m", voice: "", speed: 1.25 }, "Test");
assert(bodySpeed.voice === "", "corps: voice doit être présent même vide");
assert(bodySpeed.speed === 1.25, `corps: speed attendu 1.25, reçu ${bodySpeed.speed}`);

// Erreur « dialecte OpenAI » : seul le message est présenté à l'utilisateur.
assert(
  speech.extractHttpErrorMessage('{"error":{"message":"Model x does not exist","code":400}}') ===
    "Model x does not exist",
  "erreur HTTP: message JSON non extrait",
);
assert(
  speech.extractHttpErrorMessage('{"message":"Invalid voice"}') === "Invalid voice",
  "erreur HTTP: forme {message} non extraite",
);
assert(
  speech.extractHttpErrorMessage("Bad Gateway") === "Bad Gateway",
  "erreur HTTP: corps non-JSON altéré",
);
// JSON tronqué (corps déjà borné en amont) : renvoyé tel quel, jamais d'exception.
assert(
  speech.extractHttpErrorMessage('{"error":{"message":"trop') === '{"error":{"message":"trop',
  "erreur HTTP: JSON illisible altéré",
);
// Troncature conservée.
const long = speech.extractHttpErrorMessage(`{"error":{"message":"${"a".repeat(900)}"}}`);
assert(long.length === 501 && long.endsWith("…"), `erreur HTTP: troncature attendue, longueur ${long.length}`);

// Le format demandé est paramétrable (négociation) et vaut "mp3" par défaut.
const bodyPcm = speech.buildSpeechRequestBody(
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Zephyr", speed: 1 },
  "Bonjour !",
  "pcm",
);
assert(bodyPcm.response_format === "pcm", `corps: response_format attendu "pcm", reçu ${bodyPcm.response_format}`);
assert(speech.otherSpeechFormat("mp3") === "pcm", "otherSpeechFormat(mp3) doit valoir pcm");
assert(speech.otherSpeechFormat("pcm") === "mp3", "otherSpeechFormat(pcm) doit valoir mp3");

console.log("OK: corps /audio/speech et extraction des messages d'erreur HTTP");

// ---------------------------------------------------------------------------
// 1 ter. Détection « l'erreur porte sur le response_format » (unitaire)
// ---------------------------------------------------------------------------

// Cas positifs : le message cite le paramètre ET le format alternatif.
const rejections = [
  // Message réel observé sur OpenRouter (google/gemini-3.1-flash-tts-preview).
  ['Gemini TTS only supports response_format="pcm". Got "mp3".', "pcm"],
  // Variantes de casse et de formulation.
  ["Invalid Response_Format: this model requires PCM output", "pcm"],
  ["The 'response format' parameter must be mp3 for this model", "mp3"],
  ["response-format not supported; use pcm", "pcm"],
];
for (const [message, alternative] of rejections) {
  assert(
    speech.isResponseFormatRejection(message, alternative),
    `bascule de format non détectée pour « ${message} »`,
  );
}

// Cas négatifs : aucune ne doit déclencher la bascule.
const nonRejections = [
  // Modèle inexistant — mentionne un identifiant, jamais le paramètre.
  ["google/gemini-3.1-flash-tts-preview is not a valid model ID", "pcm"],
  // Identifiant de modèle contenant « mp3 » : la frontière de mot protège.
  ["No endpoints found for acme/tts-mp3-large.", "mp3"],
  // Voix invalide.
  ["Invalid voice 'Zephyr'. Supported voices are: alloy, echo, fable.", "pcm"],
  // Authentification.
  ["No auth credentials found", "pcm"],
  ["Incorrect API key provided.", "mp3"],
  // Cite le paramètre mais PAS le format alternatif : rejouer serait inutile.
  ['response_format="opus" is not supported', "pcm"],
];
for (const [message, alternative] of nonRejections) {
  assert(
    !speech.isResponseFormatRejection(message, alternative),
    `bascule de format déclenchée à tort pour « ${message} »`,
  );
}

console.log("OK: détection des erreurs portant sur response_format");

// ---------------------------------------------------------------------------
// 1 quater. Enveloppe WAV autour d'octets PCM déjà encodés (unitaire)
// ---------------------------------------------------------------------------

// PCM 16 bits mono 24 kHz : 1200 échantillons (0,05 s), motif reconnaissable.
const pcmSampleCount = 1200;
const pcmBytes = new Uint8Array(pcmSampleCount * 2);
const pcmView = new DataView(pcmBytes.buffer);
for (let i = 0; i < pcmSampleCount; i++) {
  pcmView.setInt16(2 * i, Math.round(20000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), true);
}

const wrapped = speech.wrapPcm16InWav(pcmBytes, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
const tagAt = (bytes, offset) =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
const wrappedView = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);

assert(wrapped.length === 44 + pcmBytes.length, `enveloppe WAV: taille attendue ${44 + pcmBytes.length}, reçue ${wrapped.length}`);
assert(tagAt(wrapped, 0) === "RIFF", "enveloppe WAV: tag RIFF attendu");
assert(tagAt(wrapped, 8) === "WAVE", "enveloppe WAV: tag WAVE attendu");
assert(tagAt(wrapped, 12) === "fmt ", "enveloppe WAV: tag « fmt » attendu");
assert(tagAt(wrapped, 36) === "data", "enveloppe WAV: tag data attendu");
assert(wrappedView.getUint32(4, true) === 36 + pcmBytes.length, "enveloppe WAV: taille RIFF incohérente");
assert(wrappedView.getUint16(20, true) === 1, "enveloppe WAV: format PCM entier attendu");
assert(wrappedView.getUint16(22, true) === 1, "enveloppe WAV: mono attendu");
assert(wrappedView.getUint32(24, true) === 24000, "enveloppe WAV: 24 000 Hz attendus");
assert(wrappedView.getUint32(28, true) === 48000, "enveloppe WAV: débit octets attendu 48000");
assert(wrappedView.getUint16(32, true) === 2, "enveloppe WAV: alignement de bloc attendu 2");
assert(wrappedView.getUint16(34, true) === 16, "enveloppe WAV: 16 bits par échantillon attendus");
assert(
  wrappedView.getUint32(40, true) === pcmBytes.length,
  "enveloppe WAV: taille annoncée du chunk data incohérente",
);

// Aller-retour par le parseur du module : les octets PCM doivent ressortir
// inchangés (à la normalisation ÷32768 près).
const reparsed = speech.parseWavPcm16Mono(wrapped);
assert(reparsed.sampleRate === 24000, `enveloppe WAV: sampleRate relu ${reparsed.sampleRate}`);
assert(reparsed.samples.length === pcmSampleCount, `enveloppe WAV: ${reparsed.samples.length} échantillons relus`);
for (let i = 0; i < pcmSampleCount; i += 37) {
  const expected = pcmView.getInt16(2 * i, true) / 32768;
  assert(reparsed.samples[i] === expected, `enveloppe WAV: échantillon ${i} altéré`);
}

// Paramètres par défaut (24 kHz mono 16 bits) quand rien n'est précisé.
const wrappedDefault = speech.wrapPcm16InWav(pcmBytes);
assert(
  new DataView(wrappedDefault.buffer).getUint32(24, true) === 24000,
  "enveloppe WAV: repli 24 000 Hz attendu",
);

// Octet orphelin ignoré : le chunk data reste un multiple de l'alignement.
const odd = speech.wrapPcm16InWav(new Uint8Array(7));
assert(odd.length === 44 + 6, `enveloppe WAV: octet orphelin non écarté (taille ${odd.length})`);
assert(new DataView(odd.buffer).getUint32(40, true) === 6, "enveloppe WAV: taille data impaire annoncée");

console.log("OK: enveloppe WAV autour d'un buffer PCM");

// ---------------------------------------------------------------------------
// 1 quinquies. Paramètres du Content-Type d'un flux PCM (unitaire)
// ---------------------------------------------------------------------------

const defaults = speech.DEFAULT_PCM_PARAMS;
assert(
  defaults.sampleRate === 24000 && defaults.channels === 1 && defaults.bitsPerSample === 16,
  "Content-Type: défauts attendus 24000/1/16",
);

const ctCases = [
  [null, 24000, 1, 16],
  ["audio/pcm", 24000, 1, 16],
  ["application/octet-stream", 24000, 1, 16],
  ["audio/pcm; rate=48000", 48000, 1, 16],
  ['audio/pcm; rate="16000"; channels=2', 16000, 2, 16],
  ["audio/L16; sample-rate=8000; bits_per_sample=16", 8000, 1, 16],
  // Valeurs aberrantes ou non numériques → repli silencieux sur les défauts.
  ["audio/pcm; rate=abc", 24000, 1, 16],
  ["audio/pcm; rate=3", 24000, 1, 16],
  ["audio/pcm; channels=8", 24000, 1, 16],
];
for (const [header, rate, channels, bits] of ctCases) {
  const got = speech.parsePcmContentType(header);
  assert(
    got.sampleRate === rate && got.channels === channels && got.bitsPerSample === bits,
    `Content-Type « ${header} » : attendu ${rate}/${channels}/${bits}, reçu ${got.sampleRate}/${got.channels}/${got.bitsPerSample}`,
  );
}

console.log("OK: parsing des paramètres du Content-Type PCM");

// ---------------------------------------------------------------------------
// 2. Protocole : validation des params, clé manquante en mode remote
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });

const received = [];
const waiters = [];

function notifyWaiters(evt) {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.predicate(evt)) {
      clearTimeout(w.timer);
      waiters.splice(i, 1);
      w.resolve(evt);
    }
  }
}

function waitFor(predicate, timeoutMs = 5000, label = "événement") {
  const existing = received.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve };
    w.timer = setTimeout(() => {
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`timeout en attendant ${label}`));
    }, timeoutMs);
    waiters.push(w);
  });
}

const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
stdoutRl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let parsedLine;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    fail(`stdout du sidecar a émis une ligne non-JSON: ${line}`);
    return;
  }
  received.push(parsedLine);
  notifyWaiters(parsedLine);
});

child.stderr.on("data", () => {});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function terminal(reqId) {
  return waitFor((e) => e.id === reqId && (e.event === "done" || e.event === "error"), 5000, reqId);
}

const wavBase64 = Buffer.from(wav).toString("base64");

try {
  await waitFor((e) => e.event === "ready", 5000, "ready");

  // speech.configure sans config → erreur.
  send({ id: "sc-1", method: "speech.configure", params: {} });
  const sc1 = await terminal("sc-1");
  assert(sc1.event === "error", `sc-1: 'error' attendu, reçu '${sc1.event}'`);
  assert(/config/.test(sc1.data.message), `sc-1: message inattendu « ${sc1.data.message} »`);

  // speech.configure avec un mode invalide → erreur citant le champ.
  send({ id: "sc-2", method: "speech.configure", params: { config: { stt: { mode: "cloud" } } } });
  const sc2 = await terminal("sc-2");
  assert(sc2.event === "error", `sc-2: 'error' attendu, reçu '${sc2.event}'`);
  assert(/config\.stt\.mode/.test(sc2.data.message), `sc-2: message inattendu « ${sc2.data.message} »`);

  // speech.configure avec une vitesse invalide → erreur citant le champ.
  send({
    id: "sc-3",
    method: "speech.configure",
    params: { config: { tts: { local: { speed: -1 } } } },
  });
  const sc3 = await terminal("sc-3");
  assert(sc3.event === "error", `sc-3: 'error' attendu, reçu '${sc3.event}'`);
  assert(/config\.tts\.local\.speed/.test(sc3.data.message), `sc-3: message inattendu « ${sc3.data.message} »`);

  // Configuration valide, tout en remote, SANS clés → done {}. La voix
  // distante vide reste ACCEPTÉE par le normalisateur (config héritée, ou voix
  // pas encore choisie) : elle sera envoyée telle quelle à /audio/speech, où
  // `voice` est requis. Un champ inconnu de l'UI (keySource, résolu côté UI)
  // est simplement ignoré.
  send({
    id: "sc-4",
    method: "speech.configure",
    params: {
      config: {
        stt: {
          mode: "remote",
          language: "fr",
          remote: { baseUrl: "https://openrouter.ai/api/v1", keySource: "openrouter" },
        },
        tts: { mode: "remote", remote: { voice: "", keySource: "openrouter" } },
      },
    },
  });
  const sc4 = await terminal("sc-4");
  assert(sc4.event === "done", `sc-4: 'done' attendu, reçu '${sc4.event}': ${JSON.stringify(sc4.data)}`);
  // La réponse porte la disponibilité de la pile de voix LOCALE : c'est elle
  // qui décide si l'interface affiche les boutons micro et conversation (voir
  // sidecar/src/speech.ts et ui/src/VoiceControls.tsx). On vérifie sa FORME,
  // pas sa valeur — celle-ci dépend légitimement de la machine : présente dans
  // le dépôt de développement, absente d'une application livrée.
  assert(
    sc4.data && typeof sc4.data.voixLocale === "object" && sc4.data.voixLocale !== null,
    `sc-4: data.voixLocale attendu, reçu ${JSON.stringify(sc4.data)}`,
  );
  assert(
    typeof sc4.data.voixLocale.disponible === "boolean" &&
      typeof sc4.data.voixLocale.dossier === "string" &&
      sc4.data.voixLocale.dossier.length > 0,
    `sc-4: voixLocale mal formée, reçu ${JSON.stringify(sc4.data.voixLocale)}`,
  );

  // speech.transcribe sans audio → erreur de validation.
  send({ id: "st-1", method: "speech.transcribe", params: {} });
  const st1 = await terminal("st-1");
  assert(st1.event === "error", `st-1: 'error' attendu, reçu '${st1.event}'`);
  assert(/audioBase64/.test(st1.data.message), `st-1: message inattendu « ${st1.data.message} »`);

  // speech.transcribe en remote sans clé → erreur claire, AVANT tout réseau.
  send({ id: "st-2", method: "speech.transcribe", params: { audioBase64: wavBase64 } });
  const st2 = await terminal("st-2");
  assert(st2.event === "error", `st-2: 'error' attendu, reçu '${st2.event}'`);
  // Message orienté utilisateur (pas de jargon interne type « keys.stt ») : il
  // est affiché tel quel dans l'UI.
  assert(
    /Clé API manquante pour la dictée/.test(st2.data.message) &&
      /Configuration . Voix/.test(st2.data.message) &&
      !/keys\./.test(st2.data.message),
    `st-2: message inattendu « ${st2.data.message} »`,
  );

  // speech.synthesize sans texte → erreur de validation.
  send({ id: "sy-1", method: "speech.synthesize", params: {} });
  const sy1 = await terminal("sy-1");
  assert(sy1.event === "error", `sy-1: 'error' attendu, reçu '${sy1.event}'`);
  assert(/text/.test(sy1.data.message), `sy-1: message inattendu « ${sy1.data.message} »`);

  // speech.synthesize avec un texte > 4000 caractères → refus explicite.
  send({ id: "sy-2", method: "speech.synthesize", params: { text: "a".repeat(4001) } });
  const sy2 = await terminal("sy-2");
  assert(sy2.event === "error", `sy-2: 'error' attendu, reçu '${sy2.event}'`);
  assert(/4000/.test(sy2.data.message), `sy-2: message inattendu « ${sy2.data.message} »`);

  // speech.synthesize en remote sans clé → erreur claire, AVANT tout réseau.
  send({ id: "sy-3", method: "speech.synthesize", params: { text: "Bonjour le monde." } });
  const sy3 = await terminal("sy-3");
  assert(sy3.event === "error", `sy-3: 'error' attendu, reçu '${sy3.event}'`);
  assert(
    /Clé API manquante pour la synthèse vocale/.test(sy3.data.message) &&
      /Configuration . Voix/.test(sy3.data.message) &&
      !/keys\./.test(sy3.data.message),
    `sy-3: message inattendu « ${sy3.data.message} »`,
  );

  // Bascule en STT local : un WAV corrompu doit être rejeté par le parseur
  // AVANT tout chargement de modèle (donc sans réseau ni téléchargement).
  send({ id: "sc-5", method: "speech.configure", params: { config: { stt: { mode: "local" } } } });
  const sc5 = await terminal("sc-5");
  assert(sc5.event === "done", `sc-5: 'done' attendu, reçu '${sc5.event}'`);

  send({
    id: "st-3",
    method: "speech.transcribe",
    params: { audioBase64: Buffer.from("pas un wav pour deux sous, juste du texte").toString("base64") },
  });
  const st3 = await terminal("st-3");
  assert(st3.event === "error", `st-3: 'error' attendu, reçu '${st3.event}'`);
  assert(/WAV/.test(st3.data.message), `st-3: message inattendu « ${st3.data.message} »`);

  console.log("OK: validation des params et clés manquantes en mode remote");
  console.log("OK: tous les tests speech sont passés");
} finally {
  child.kill();
}
