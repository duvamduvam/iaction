/*
 * Sonde de latence de frappe — l'instrument réclamé par T-095.
 *
 * ── Pourquoi un instrument ──────────────────────────────────────────────
 * « C'est lent quand je tape » a été signalé cinq fois. Deux tickets ont été
 * soldés dessus (T-031 : plus aucun coût JS par caractère ; T-083 : la couche
 * plein écran qui faisait repeindre tout le viewport), et le symptôme est
 * revenu les deux fois. La raison est toujours la même : chaque enquête a
 * relu le CSS et raisonné, personne n'a jamais MESURÉ. Sans chiffre, on ne
 * sait ni si une correction a servi, ni de combien, ni ce qu'il reste.
 *
 * Ce module produit le chiffre, et il sépare les deux moitiés du trajet —
 * c'est toute son utilité, parce qu'elles n'accusent pas le même coupable :
 *
 * - ATTENTE : de l'horodatage système de la touche (`event.timeStamp`, posé
 *   par le compositeur) à l'entrée dans le gestionnaire JS. Ce qui se paie
 *   ici, c'est un fil principal occupé ailleurs — du JS, un rendu React, un
 *   ramassage mémoire. Suspect : l'application.
 * - RENDU : du gestionnaire JS à la trame suivant celle qui a peint le
 *   caractère (double `requestAnimationFrame`). Ce qui se paie ici, c'est la
 *   mise en page et la rastérisation. Suspect : le CSS, ou le renderer —
 *   rappel de T-095, la fenêtre tourne en rendu LOGICIEL sur 3840 × 2109.
 *
 * Un total élevé porté par l'ATTENTE et un total élevé porté par le RENDU
 * n'ont pas la même correction. C'est exactement la distinction que quatre
 * enquêtes successives n'ont pas pu faire.
 *
 * ── Les suspects isolables à chaud ──────────────────────────────────────
 * Mesurer ne suffit pas : il faut pouvoir retirer un suspect SANS relancer,
 * sans recompiler, et remesurer dans la foulée. D'où le mode « nu », qui
 * neutralise par paliers les décorations coûteuses (ombres et lueurs, puis
 * animations et transitions, puis fonds et arrondis) via une classe posée sur
 * `<html>` — voir la section « SONDE T-095 » d'App.css. Le palier qui fait
 * chuter le RENDU nomme le coupable ; si aucun ne le fait chuter, le coupable
 * n'est pas dans la feuille de style, et l'enquête doit sortir de l'UI.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   Ctrl+Maj+M   allume / éteint la sonde (et son afficheur en bas à droite)
 *   Ctrl+Maj+D   dénude : fait tourner le mode « nu » d'un palier
 *   Ctrl+Maj+B   bilan : consigne le relevé au journal, puis remet à zéro
 *
 * POURQUOI Ctrl+MAJ et pas Ctrl+Alt (premier choix, abandonné le 2026-08-30) :
 * sur ce poste, GNOME a fait de Ctrl+Alt son lanceur d'applications — Ctrl+Alt
 * +M ouvrait Thunderbird, et douze autres lettres sont prises de la même façon
 * (t, k, w, z, v, c, s, e, b, f, i…). Un raccourci capté par le bureau
 * n'atteint JAMAIS la webview : il n'y a rien à corriger côté application, il
 * faut sortir du namespace. Ctrl+Maj est libre côté GNOME (qui n'y réserve que
 * des combinaisons à trois modificateurs), et l'application n'y utilise que N,
 * L, P, Z et Tab.
 *
 * Repli sans aucun raccourci, si une combinaison est captée un jour : les
 * mêmes commandes sont exposées sur `window.sondeFrappe` (`allumer()`,
 * `eteindre()`, `denuder()`, `bilan()`), utilisables depuis l'inspecteur.
 *
 * Le protocole de mesure tient en trois gestes : allumer, taper une phrase
 * entière (30 caractères au moins, les premiers portent le coût de mise en
 * cache), lire p95. Puis changer UN paramètre, Ctrl+Alt+R, retaper la même
 * phrase. Comparer des p95, jamais des impressions.
 *
 * ── Coût de la sonde elle-même ──────────────────────────────────────────
 * Éteinte : un écouteur `keydown` dont la première ligne écarte tout ce qui
 * n'est pas Ctrl+Alt. C'est le seul prix permanent, et il est assumé — sans
 * lui, l'instrument ne s'allume qu'avec les outils de développement ouverts,
 * ce qui change ce qu'on mesure.
 * Allumée : deux `requestAnimationFrame` par caractère, aucune allocation de
 * tableau (registres circulaires en `Float64Array`), et un afficheur redessiné
 * au plus deux fois par seconde, en bas à droite, hors du flux (`position:
 * fixed`, `pointer-events: none`) pour qu'il ne salisse pas la zone de frappe.
 */
import { logInfo } from "./journal";

/* ────────────────────────── Partie pure (testée) ────────────────────────── */

/** Registre circulaire de mesures, dimensionné une fois pour toutes. */
export interface Registre {
  valeurs: Float64Array;
  /** Prochaine case à écrire. */
  curseur: number;
  /** Nombre total d'ajouts depuis la dernière remise à zéro (peut dépasser la capacité). */
  total: number;
}

/** Résumé statistique d'un registre. `null` quand il est vide. */
export interface Resume {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * 512 caractères : de quoi couvrir plusieurs phrases sans que le registre
 * garde la trace d'une mesure faite sous un AUTRE réglage — un registre trop
 * long mélangerait les campagnes, et c'est justement ce qu'on veut éviter.
 */
export const CAPACITE_REGISTRE = 512;

export function creerRegistre(capacite: number = CAPACITE_REGISTRE): Registre {
  return { valeurs: new Float64Array(capacite), curseur: 0, total: 0 };
}

/** Ajoute une mesure ; au-delà de la capacité, la plus ancienne est écrasée. */
export function ajouter(reg: Registre, valeur: number): void {
  if (!Number.isFinite(valeur)) return;
  reg.valeurs[reg.curseur] = valeur;
  reg.curseur = (reg.curseur + 1) % reg.valeurs.length;
  reg.total += 1;
}

export function raz(reg: Registre): void {
  reg.curseur = 0;
  reg.total = 0;
}

/** Les mesures effectivement retenues, dans un ordre quelconque. */
export function echantillons(reg: Registre): number[] {
  const n = Math.min(reg.total, reg.valeurs.length);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(reg.valeurs[i]);
  return out;
}

/**
 * Centile par rang le plus proche (méthode « nearest-rank ») : le plus petit
 * échantillon sous lequel se trouvent au moins p % des mesures. Pas
 * d'interpolation — sur des latences, une valeur RÉELLEMENT observée est plus
 * facile à recouper qu'une moyenne pondérée de deux voisines.
 */
export function centile(tries: number[], p: number): number {
  if (tries.length === 0) return NaN;
  const rang = Math.ceil((p / 100) * tries.length);
  const i = Math.min(tries.length - 1, Math.max(0, rang - 1));
  return tries[i];
}

export function resume(reg: Registre): Resume | null {
  const tries = echantillons(reg).sort((a, b) => a - b);
  if (tries.length === 0) return null;
  return {
    n: tries.length,
    p50: centile(tries, 50),
    p95: centile(tries, 95),
    max: tries[tries.length - 1],
  };
}

/**
 * Paliers du mode « nu », dans l'ordre du cycle. Chaque palier CUMULE les
 * précédents (la classe CSS `sonde-nu--<n>` neutralise tout jusqu'à `n`) :
 * bissecter demande d'ajouter un suspect à la fois, pas de les permuter.
 */
export const PALIERS_NU = [
  { classe: "", nom: "aucun" },
  { classe: "sonde-nu--1", nom: "1 · sans ombres ni lueurs" },
  { classe: "sonde-nu--2", nom: "2 · + sans animations" },
  { classe: "sonde-nu--3", nom: "3 · + sans fonds ni arrondis" },
] as const;

export function palierSuivant(courant: number): number {
  return (courant + 1) % PALIERS_NU.length;
}

/**
 * Ligne « terrain » de l'afficheur : depuis combien de temps cette page vit,
 * et combien de nœuds elle porte.
 *
 * POURQUOI ces deux-là et pas d'autres. Le 2026-08-30, la frappe est redevenue
 * fluide au moment EXACT où Vite a rechargé la page — alors que le code posé
 * ce jour-là ne rend rien plus rapide (la sonde était éteinte, et elle ajoute
 * un écouteur). Si un simple rechargement suffit, le coût ne vient ni du CSS
 * ni du renderer : il s'ACCUMULE avec la durée de vie de la page. Ce qui
 * expliquerait d'un coup les cinq signalements — chaque correction précédente
 * a été jugée juste après un relancement, donc sur une page neuve, donc au
 * meilleur de sa forme.
 *
 * Une hypothèse ne vaut que si elle est réfutable : un p95 relevé à 5 min puis
 * à 3 h sur la MÊME phrase la confirme ou l'enterre.
 */
export function formaterTerrain(ageMs: number, noeuds: number): string {
  const min = Math.floor(ageMs / 60000);
  const age = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
  return `page ${age} · ${noeuds.toLocaleString("fr-FR")} nœuds`;
}

/** Une ligne d'afficheur, alignée en colonnes de largeur fixe (police à chasse fixe). */
export function formaterLigne(etiquette: string, r: Resume | null): string {
  const col = (v: number) => `${Math.round(v)}`.padStart(4);
  if (!r) return `${etiquette.padEnd(8)}   —`;
  return `${etiquette.padEnd(8)}${col(r.p50)}${col(r.p95)}${col(r.max)}`;
}

/* ──────────────────────── Partie impure (navigateur) ────────────────────── */

const CLE_ACTIVE = "iaction.sondeFrappe.active";

/** Une touche qui n'ajoute pas de caractère ne coûte pas la même chose : on ne la mesure pas. */
function toucheImprimable(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key.length === 1 || e.key === "Enter" || e.key === "Backspace";
}

function dansZoneDeSaisie(cible: EventTarget | null): boolean {
  const el = cible as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const t = el.tagName.toLowerCase();
  return t === "textarea" || t === "input" || el.isContentEditable === true;
}

interface Etat {
  active: boolean;
  palier: number;
  attente: Registre;
  rendu: Registre;
  total: Registre;
  hud: HTMLElement | null;
  /** Zone des chiffres, réécrite deux fois par seconde. */
  chiffres: HTMLElement | null;
  /** Bouton du palier « nu » — porte son nom courant. */
  boutonNu: HTMLElement | null;
  minuteur: number | null;
}

const etat: Etat = {
  active: false,
  palier: 0,
  attente: creerRegistre(),
  rendu: creerRegistre(),
  total: creerRegistre(),
  hud: null,
  chiffres: null,
  boutonNu: null,
  minuteur: null,
};

/**
 * `event.timeStamp` et `performance.now()` partagent la même origine de temps
 * — sauf accident (émulation, événement synthétique, horloge remise à l'heure).
 * Une attente négative ou absurde n'est PAS comptée plutôt que d'empoisonner
 * la médiane : un instrument qui ment une fois ne sert plus jamais.
 */
function attentePlausible(depart: number, arrivee: number): number | null {
  const d = arrivee - depart;
  if (!Number.isFinite(d) || d < 0 || d > 5000) return null;
  return d;
}

function surFrappe(e: KeyboardEvent): void {
  if (!etat.active) return;
  if (!toucheImprimable(e) || !dansZoneDeSaisie(e.target)) return;

  const entreeJs = performance.now();
  const attente = attentePlausible(e.timeStamp, entreeJs);

  // Double trame : la PREMIÈRE se déclenche avant la peinture de l'image en
  // cours, la seconde une fois cette image envoyée. Le caractère est donc
  // visible quand la seconde part — c'est la définition la plus proche de
  // « je vois ma lettre » qu'une page puisse mesurer d'elle-même.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const peint = performance.now();
      ajouter(etat.rendu, peint - entreeJs);
      if (attente !== null) {
        ajouter(etat.attente, attente);
        ajouter(etat.total, peint - e.timeStamp);
      }
    });
  });
}

/**
 * Nombre de nœuds du document, RECALCULÉ au plus toutes les 2 s : parcourir un
 * gros DOM coûte, et un instrument qui se paie sur ce qu'il mesure ment.
 */
let noeudsCache = 0;
let noeudsDate = 0;
function compterNoeuds(maintenant: number): number {
  if (maintenant - noeudsDate < 2000 && noeudsCache > 0) return noeudsCache;
  noeudsDate = maintenant;
  noeudsCache = document.getElementsByTagName("*").length;
  return noeudsCache;
}

function texteHud(): string {
  const dpr = window.devicePixelRatio || 1;
  const px = `${Math.round(window.innerWidth * dpr)}×${Math.round(window.innerHeight * dpr)}`;
  const r = resume(etat.total);
  return [
    `SONDE FRAPPE   n=${r ? r.n : 0}`,
    `${" ".repeat(8)} p50 p95 max`,
    formaterLigne("attente", resume(etat.attente)),
    formaterLigne("rendu", resume(etat.rendu)),
    formaterLigne("total", r),
    formaterTerrain(performance.now(), compterNoeuds(performance.now())),
    `${px} px`,
  ].join("\n");
}

function majHud(): void {
  if (etat.chiffres) etat.chiffres.textContent = texteHud();
  if (etat.boutonNu) etat.boutonNu.textContent = `nu: ${PALIERS_NU[etat.palier].nom}`;
}

/** Bouton de l'afficheur : petit, lisible, et qui ne vole jamais le focus. */
function creerBouton(libelle: string, action: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = libelle;
  b.style.cssText = [
    "font:11px ui-monospace,Menlo,Consolas,monospace",
    "color:#e6fffb",
    "background:#12233a",
    "border:1px solid #2b5f7a",
    "border-radius:3px",
    "padding:2px 6px",
    "cursor:pointer",
  ].join(";");
  // Le clic ne doit PAS sortir le curseur de la zone de frappe : sans ça, il
  // faudrait recliquer dans le composeur entre chaque étape de la bissection,
  // et la mesure suivante commencerait par un clic au lieu d'une touche.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    action();
  });
  return b;
}

/*
 * Pourquoi des BOUTONS et pas seulement des raccourcis (2026-08-30) : deux
 * bissections de suite sont revenues étiquetées `nu: aucun`, alors que les
 * compteurs se vident au changement de palier — donc `Ctrl+Maj+D` n'atteignait
 * pas le code. Rien dans l'application ne capte cette touche, et l'écouteur
 * passe avant React : elle était donc avalée plus haut (bureau, WebKit), ou
 * n'est pas partie. Dans les deux cas, ce n'est pas vérifiable depuis ici, et
 * ce n'est pas à l'utilisateur de refaire trois fois la même manipulation pour
 * en avoir le cœur net. Un bouton visible ne peut être intercepté par
 * personne, et il MONTRE l'état au lieu de le supposer.
 */
function creerHud(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-sonde-frappe", "");
  // Style en ligne, volontairement : l'afficheur doit rester lisible même sous
  // le palier 3 du mode « nu », qui efface les fonds de toute la feuille.
  el.style.cssText = [
    "position:fixed",
    "right:8px",
    "bottom:8px",
    "z-index:2147483647",
    "margin:0",
    "padding:6px 8px",
    "font:11px/1.35 ui-monospace,Menlo,Consolas,monospace",
    "white-space:pre",
    "color:#e6fffb",
    "background:#0b1220",
    "border:1px solid #00f5d4",
    "border-radius:4px",
    "user-select:none",
    "display:flex",
    "flex-direction:column",
    "gap:5px",
  ].join(";");

  const chiffres = document.createElement("pre");
  chiffres.style.cssText = "margin:0;font:inherit;white-space:pre";
  el.appendChild(chiffres);
  etat.chiffres = chiffres;

  const barre = document.createElement("div");
  barre.style.cssText = "display:flex;gap:4px";
  etat.boutonNu = creerBouton("nu: —", () => appliquerPalier(palierSuivant(etat.palier)));
  barre.appendChild(etat.boutonNu);
  barre.appendChild(creerBouton("bilan", consignerEtRaz));
  barre.appendChild(creerBouton("×", eteindre));
  el.appendChild(barre);
  return el;
}

function allumer(): void {
  if (etat.active) return;
  etat.active = true;
  etat.hud = creerHud();
  // Le module est importé avant le rendu : au tout premier chargement, `body`
  // peut ne pas encore exister.
  if (document.body) document.body.appendChild(etat.hud);
  else document.addEventListener("DOMContentLoaded", () => {
    if (etat.hud) document.body.appendChild(etat.hud);
  }, { once: true });
  majHud();
  // Deux rafraîchissements par seconde : assez pour voir la mesure se poser,
  // assez peu pour ne pas devenir lui-même un coût de frappe.
  etat.minuteur = window.setInterval(majHud, 500);
  try {
    localStorage.setItem(CLE_ACTIVE, "1");
  } catch {
    /* stockage indisponible : la sonde marche quand même, elle ne survit pas au rechargement */
  }
}

function eteindre(): void {
  if (!etat.active) return;
  etat.active = false;
  if (etat.minuteur !== null) window.clearInterval(etat.minuteur);
  etat.minuteur = null;
  etat.hud?.remove();
  etat.hud = null;
  etat.chiffres = null;
  etat.boutonNu = null;
  try {
    localStorage.removeItem(CLE_ACTIVE);
  } catch {
    /* voir ci-dessus */
  }
}

/**
 * Change de palier ET REMET LES COMPTEURS À ZÉRO.
 *
 * Le 2026-08-30, un relevé de bissection est revenu étiqueté `nu: aucun` alors
 * que la mesure avait probablement été prise sous le palier 3 : l'étiquette
 * était lue au moment du BILAN, pas au moment des mesures, et l'utilisateur
 * avait rétabli l'affichage avant de consigner. Une mesure juste sous une
 * étiquette fausse est pire qu'une mesure absente — elle se recopie dans un
 * ticket et sert de preuve.
 *
 * Deux verrous plutôt qu'une consigne d'usage : un registre n'appartient qu'à
 * UN palier (changer de palier vide les compteurs), et le bilan refuse de
 * consigner une campagne vide. Il n'y a donc plus d'ordre des gestes à
 * retenir : quel que soit le moment où l'on consigne, l'étiquette est celle
 * sous laquelle les caractères ont été tapés.
 */
function appliquerPalier(n: number): void {
  if (n !== etat.palier) {
    raz(etat.attente);
    raz(etat.rendu);
    raz(etat.total);
  }
  etat.palier = n;
  const racine = document.documentElement;
  for (const p of PALIERS_NU) if (p.classe) racine.classList.remove(p.classe);
  const classe = PALIERS_NU[n].classe;
  if (classe) racine.classList.add(classe);
  majHud();
}

/**
 * Consigne le relevé AVANT de repartir de zéro. C'est la moitié qui compte :
 * une mesure qui ne laisse pas de trace est une mesure à refaire — et T-095
 * dit noir sur blanc que c'est pour ça que le sujet semble repartir de zéro à
 * chaque signalement.
 */
function consignerEtRaz(): void {
  const t = resume(etat.total);
  // Une campagne vide ne dit rien, et une ligne de journal vide se lit plus
  // tard comme un « zéro mesuré ». On ne consigne pas.
  if (!t) {
    majHud();
    return;
  }
  const a = resume(etat.attente);
  const r = resume(etat.rendu);
  logInfo("ui", "sonde de frappe — relevé", {
    fields: {
      n: t.n,
      nu: PALIERS_NU[etat.palier].nom,
      attente_p50: a ? Math.round(a.p50) : 0,
      attente_p95: a ? Math.round(a.p95) : 0,
      rendu_p50: r ? Math.round(r.p50) : 0,
      rendu_p95: r ? Math.round(r.p95) : 0,
      total_p50: Math.round(t.p50),
      total_p95: Math.round(t.p95),
      total_max: Math.round(t.max),
      page_min: Math.round(performance.now() / 60000),
      noeuds_dom: document.getElementsByTagName("*").length,
      largeur_px: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
      hauteur_px: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
    },
  });
  raz(etat.attente);
  raz(etat.rendu);
  raz(etat.total);
  majHud();
}

function basculer(): void {
  if (etat.active) eteindre();
  else allumer();
}

function denuder(): void {
  appliquerPalier(palierSuivant(etat.palier));
}

function surRaccourci(e: KeyboardEvent): void {
  // PREMIÈRE ligne : le coût permanent de la sonde éteinte se résume à ce test.
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === "m") {
    e.preventDefault();
    basculer();
  } else if (k === "d") {
    e.preventDefault();
    denuder();
  } else if (k === "b") {
    e.preventDefault();
    consignerEtRaz();
  }
}

let installee = false;

/**
 * Installe la sonde. Appelé une seule fois depuis `main.tsx`, AVANT le rendu :
 * l'écouteur est en phase de capture pour horodater la touche au plus tôt,
 * avant que React ne l'ait vue.
 */
export function installerSondeFrappe(): void {
  if (installee || typeof window === "undefined") return;
  installee = true;
  window.addEventListener("keydown", surRaccourci, true);
  // Repli sans raccourci : un bureau peut capter n'importe quelle
  // combinaison AVANT la webview, et le constat du 2026-08-30 montre que ça
  // ne se voit pas — la touche ne fait simplement rien. Une commande qu'on
  // peut taper dans l'inspecteur ne peut, elle, être captée par personne.
  (window as unknown as Record<string, unknown>).sondeFrappe = {
    allumer,
    eteindre,
    denuder,
    bilan: consignerEtRaz,
  };
  window.addEventListener("keydown", surFrappe, { capture: true, passive: true });
  // Une campagne de mesure survit au rechargement à chaud de Vite : sans ça,
  // toucher une ligne de CSS pendant l'enquête éteindrait l'instrument.
  try {
    if (localStorage.getItem(CLE_ACTIVE) === "1") allumer();
  } catch {
    /* stockage indisponible */
  }
}
