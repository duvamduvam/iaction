/*
 * Prototype d'avatar parlant — rendu three.js d'une tête à 52 poses ARKit.
 *
 * Trois couches de poids s'additionnent à chaque image (bornées à 1) :
 *   1. l'ÉMOTION courante (emotions.js), interpolée pour ne jamais sauter ;
 *   2. la BOUCHE de parole (jawOpen & co) ;
 *   3. la VIE au repos : clignements, micro-saccades, balancement de tête.
 *
 * Bouche — deux sources, de fidélité très différente (le dire à l'écran) :
 *   - fichier audio / micro : volume réel mesuré (AnalyserNode) → bouche
 *     calée sur le son. C'est le chemin qu'empruntera la voix d'IAction
 *     (audioPlayback.ts joue des HTMLAudioElement, branchables pareil) ;
 *   - voix du navigateur (speechSynthesis) : l'API ne donne PAS accès au
 *     son, la bouche est donc SIMULÉE (oscillation pendant la parole).
 * Audio2Face-3D remplacera la couche 2 (et affinera la 1) dans un lot
 * ultérieur : il produit directement les 52 poids depuis l'audio.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EMOTIONS, decouperBalises, rapprocher, indexPose } from "./emotions.js";

const BASIS = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/";

// ── Scène ───────────────────────────────────────────────────────────────
const zone = document.getElementById("scene");
// Fond transparent : le dégradé vient du CSS (#scene), plus chaud qu'un aplat.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
zone.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment()).texture;
// Éclairage de portrait : principale chaude de trois-quarts, contre-jour
// froid pour détacher la silhouette du fond.
const principale = new THREE.DirectionalLight(0xffe2c8, 1.6);
principale.position.set(1.5, 2, 2.5);
const contre = new THREE.DirectionalLight(0x9fb8ff, 1.2);
contre.position.set(-2, 1.5, -2);
scene.add(principale, contre);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
const controles = new OrbitControls(camera, renderer.domElement);
controles.enableDamping = true;

function redimensionner() {
  const { clientWidth: l, clientHeight: h } = zone;
  renderer.setSize(l, h);
  camera.aspect = l / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", redimensionner);
redimensionner();

// ── Chargement d'une tête ───────────────────────────────────────────────
const loader = new GLTFLoader()
  .setKTX2Loader(new KTX2Loader().setTranscoderPath(BASIS).detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder);

/** Maillages porteurs de poses : une tête MetaHuman en a plusieurs (peau, dents, yeux). */
let maillages = [];
let racine = null;
/** Os de la tête (corps entiers : Ready Player Me, Avaturn, MPFB) ; null pour une tête seule. */
let teteOs = null;
const etat = document.getElementById("etat");

function charger(url) {
  loader.load(url, (gltf) => {
    if (racine) scene.remove(racine);
    racine = gltf.scene;
    scene.add(racine);
    maillages = [];
    racine.traverse((o) => { if (o.morphTargetDictionary) maillages.push(o); });
    const noms = new Set(maillages.flatMap((m) => Object.keys(m.morphTargetDictionary)));
    const reconnues = ["mouthSmile_L", "eyeBlink_L", "browDown_L"]
      .filter((n) => maillages.some((m) => indexPose(m.morphTargetDictionary, n) !== undefined));
    // Cadrage : sur un corps entier, on vise l'os « Head » (modèles en
    // mètres, regard vers +Z) ; sur une tête seule, sa boîte englobante.
    teteOs = racine.getObjectByName("Head") ?? null;
    if (teteOs) teteOs.userData.repos = teteOs.rotation.clone();
    racine.updateWorldMatrix(true, true);
    let centre, recul;
    if (teteOs) {
      centre = teteOs.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.06, 0));
      recul = 0.75;
    } else {
      const boite = new THREE.Box3().setFromObject(racine);
      centre = boite.getCenter(new THREE.Vector3());
      recul = boite.getSize(new THREE.Vector3()).length() * 1.6;
    }
    controles.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(0, 0.02, recul));
    camera.near = recul / 100; camera.far = recul * 20;
    camera.updateProjectionMatrix();
    etat.textContent = `Modèle chargé : ${noms.size} poses` +
      (reconnues.length < 3 ? " ⚠️ poses latéralisées introuvables (sourire, clignement…)" : "") +
      (noms.has("jawOpen") ? "" : " ⚠️ pas de jawOpen — ce n'est pas une tête ARKit");
  }, undefined, (err) => {
    etat.textContent = `Échec du chargement de ${url} — lancer telecharger-modele.sh ? (${err.message ?? err})`;
  });
}
// `?modele=avaturn` choisit le modèle de départ (captures de vérification).
const choix = document.getElementById("choix-modele");
choix.value = new URLSearchParams(location.search).get("modele") ?? choix.value;
choix.addEventListener("change", () => charger(`modeles/${choix.value}.glb`));
charger(`modeles/${choix.value}.glb`);
document.getElementById("fichier-glb").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) charger(URL.createObjectURL(f));
});

// ── Couche 1 : émotion ──────────────────────────────────────────────────
let emotionCible = "neutre";
let poidsEmotion = {};
const etiquette = document.getElementById("emotion-courante");
function poserEmotion(nom) {
  emotionCible = nom;
  etiquette.textContent = nom;
  document.querySelectorAll("[data-emotion]").forEach((b) =>
    b.classList.toggle("actif", b.dataset.emotion === nom));
}
const boutons = document.getElementById("boutons-emotion");
for (const nom of Object.keys(EMOTIONS)) {
  const b = document.createElement("button");
  b.textContent = nom; b.dataset.emotion = nom;
  b.onclick = () => poserEmotion(nom);
  boutons.appendChild(b);
}
// `?emotion=joie` : émotion de départ (sert aux captures de vérification).
const depart = new URLSearchParams(location.search).get("emotion");
poserEmotion(depart in EMOTIONS ? depart : "neutre");

// ── Couche 2 : bouche ───────────────────────────────────────────────────
let ouverture = 0;              // 0..1, lissé
let sourceBouche = null;        // () => niveau brut 0..1, ou null au repos
let contexteAudio = null;

/** Volume RMS d'un AnalyserNode, ramené grossièrement à 0..1 pour jawOpen. */
function niveauDepuis(analyseur) {
  const buf = new Float32Array(analyseur.fftSize);
  return () => {
    analyseur.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    // Gain empirique : une voix normale donne un RMS ~0,05-0,15.
    return Math.min(1, Math.sqrt(s / buf.length) * 6);
  };
}
function analyseurSur(noeud) {
  contexteAudio ??= new AudioContext();
  const a = contexteAudio.createAnalyser();
  a.fftSize = 1024;
  noeud.connect(a);
  return a;
}

document.getElementById("fichier-audio").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const audio = new Audio(URL.createObjectURL(f));
  contexteAudio ??= new AudioContext();
  const source = contexteAudio.createMediaElementSource(audio);
  const a = analyseurSur(source);
  a.connect(contexteAudio.destination);   // on veut aussi l'entendre
  sourceBouche = niveauDepuis(a);
  audio.onended = () => { sourceBouche = null; };
  audio.play();
});

let flux = null;
document.getElementById("micro").addEventListener("click", async (e) => {
  if (flux) {                              // second clic = arrêt
    flux.getTracks().forEach((t) => t.stop()); flux = null; sourceBouche = null;
    e.target.textContent = "🎙️ Miroir micro"; return;
  }
  flux = await navigator.mediaDevices.getUserMedia({ audio: true });
  contexteAudio ??= new AudioContext();
  // PAS relié à la sortie : sinon effet Larsen.
  sourceBouche = niveauDepuis(analyseurSur(contexteAudio.createMediaStreamSource(flux)));
  e.target.textContent = "⏹️ Couper le micro";
});

/** Parole du navigateur, segment par segment : chaque segment pose son émotion. */
function parler(reponse) {
  speechSynthesis.cancel();
  const voixFr = speechSynthesis.getVoices().find((v) => v.lang.startsWith("fr"));
  if (!voixFr) etat.textContent = "⚠️ aucune voix française dans ce navigateur — voix par défaut";
  for (const { emotion, texte } of decouperBalises(reponse, emotionCible)) {
    const u = new SpeechSynthesisUtterance(texte);
    if (voixFr) u.voice = voixFr;
    u.lang = "fr-FR";
    u.onstart = () => {
      poserEmotion(emotion);
      // Bouche SIMULÉE : l'API ne donne pas le son (voir l'en-tête).
      sourceBouche = () => 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 85));
    };
    u.onend = () => { if (!speechSynthesis.speaking) sourceBouche = null; };
    speechSynthesis.speak(u);
  }
}
document.getElementById("parler").addEventListener("click", () =>
  parler(document.getElementById("texte").value));

// ── Couche 3 : vie au repos ─────────────────────────────────────────────
let prochainClignement = 2;
let clignement = 0;            // 0..1
let regard = { x: 0, y: 0 }, regardCible = { x: 0, y: 0 }, prochaineSaccade = 1;

function vie(t, dt) {
  if (t > prochainClignement) { clignement = 1; prochainClignement = t + 2 + Math.random() * 4; }
  clignement = Math.max(0, clignement - dt * 8);  // fermeture-réouverture ~120 ms
  if (t > prochaineSaccade) {
    regardCible = { x: (Math.random() - 0.5) * 0.3, y: (Math.random() - 0.5) * 0.2 };
    prochaineSaccade = t + 0.8 + Math.random() * 2.5;
  }
  regard.x += (regardCible.x - regard.x) * Math.min(1, dt * 20);
  regard.y += (regardCible.y - regard.y) * Math.min(1, dt * 20);
  const p = { eyeBlink_L: clignement, eyeBlink_R: clignement };
  // Regard à droite = œil gauche « Out », œil droit « In » (convention ARKit).
  if (regard.x > 0) { p.eyeLookOut_L = regard.x; p.eyeLookIn_R = regard.x; }
  else { p.eyeLookIn_L = -regard.x; p.eyeLookOut_R = -regard.x; }
  if (regard.y > 0) { p.eyeLookUp_L = regard.y; p.eyeLookUp_R = regard.y; }
  else { p.eyeLookDown_L = -regard.y; p.eyeLookDown_R = -regard.y; }
  // Balancement : l'os de la tête s'il existe (sinon tout le corps tournerait).
  const cible = teteOs ?? racine;
  if (cible) {
    const repos = cible.userData.repos ?? { x: 0, y: 0 };
    cible.rotation.y = repos.y + Math.sin(t * 0.4) * 0.04;
    cible.rotation.x = repos.x + Math.sin(t * 0.27) * 0.02 + (sourceBouche ? Math.sin(t * 3) * 0.01 : 0);
  }
  return p;
}

const intensite = document.getElementById("intensite");

// ── Boucle ──────────────────────────────────────────────────────────────
const horloge = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(horloge.getDelta(), 0.1);
  const t = horloge.elapsedTime;
  poidsEmotion = rapprocher(poidsEmotion, EMOTIONS[emotionCible], dt, 5);
  const brut = sourceBouche ? sourceBouche() : 0;
  ouverture += (brut - ouverture) * Math.min(1, dt * 25);
  // Intensité : les poses varient d'un modèle à l'autre (Avaturn est plus
  // discrète que Face Cap), le curseur compense sans toucher au contrat.
  const gain = Number(intensite.value);
  const total = {};
  for (const [nom, v] of Object.entries(poidsEmotion)) total[nom] = Math.min(1, v * gain);
  const ajouter = (nom, v) => { total[nom] = Math.min(1, (total[nom] ?? 0) + v); };
  ajouter("jawOpen", ouverture * 0.55);
  ajouter("mouthLowerDown_L", ouverture * 0.3);
  ajouter("mouthLowerDown_R", ouverture * 0.3);
  for (const [nom, v] of Object.entries(vie(t, dt))) ajouter(nom, v);
  for (const m of maillages) {
    m.morphTargetInfluences.fill(0);
    for (const [nom, v] of Object.entries(total)) {
      const i = indexPose(m.morphTargetDictionary, nom);
      if (i !== undefined) m.morphTargetInfluences[i] = v;
    }
  }
  controles.update();
  renderer.render(scene, camera);
});
