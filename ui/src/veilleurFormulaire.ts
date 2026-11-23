/*
 * Veilleur du relais (T-227) — logique PURE de la section « Veilleur » et de
 * l'indicateur d'en-tête : formulaire ⇄ config, libellés d'état, bilan.
 * Testée seule (veilleurFormulaire.test.ts) ; les composants restent minces.
 *
 * La validation qui fait foi est celle du sidecar (`veilleur.configurer`
 * refuse une config invalide) ; celle-ci ne sert qu'à dire tôt ce qui manque.
 * Permission : jamais choisie ici, elle découle de Bash (bypassPermissions
 * avec Bash, acceptEdits sans), comme l'exige le sidecar.
 */
import type { ConfigVeilleur, EtatVeilleur, StatutVeilleur } from "./veilleurClient";

/** Champs du formulaire, tels que saisis (chaînes pour les nombres). */
export interface FormulaireVeilleur {
  url: string;
  jetonSecret: string;
  /** Studios écoutés, séparés par des virgules. */
  expediteurs: string;
  modele: string;
  effort: string;
  bash: boolean;
  profondeur: string;
  coutParMessage: string;
  toursParJour: string;
  dureeMin: string;
  cadenceSec: string;
  proxy: string;
  ca: string;
  /** Agent du projet employé par les tours (`""` = aucun) — AFFICHÉ, puisqu'il est scellé. */
  agent: string;
  /** État enregistré et scellé (posé par « Activer » / « Désactiver ») — AFFICHÉ, jamais repris en silence. */
  actif: boolean;
}

/** Forme d'un nom de boîte du broker (même règle que le sidecar). */
export const NOM_STUDIO = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Après « Enregistrer et approuver » : écrite ET scellée au coffre de ce poste. */
export const INFO_APPROBATION = "Config enregistrée et approuvée pour ce poste (scellée au coffre). Les outils du relais et le veilleur l'acceptent désormais.";

/** Config réécrite hors de l'interface : ce qu'il faut faire. */
export const GESTE_SCELLE =
  "La config de ce projet a été modifiée hors de l'interface : ni le veilleur ni les outils du relais ne l'utilisent. Vérifiez les champs ci-dessous, puis « Enregistrer et approuver ».";

/** Encart d'une config non approuvée : ce qui diffère de la dernière version approuvée, si elle est connue. */
export function encartNonApprouvee(differences: string[] | null): string {
  if (differences === null) return "Aucune version approuvée n'est connue sur ce poste pour ce projet : rien n'est repris du fichier (actif : non, agent : aucun).";
  if (differences.length === 0) return "Le fichier ne diffère pas, champ à champ, de la dernière version approuvée : c'est un fichier qu'il désigne (agent, autorité de certification) qui a changé.";
  return `Champs qui diffèrent de la dernière version approuvée : ${differences.join(", ")}. Actif et agent ne sont pas repris du fichier.`;
}

/** Le motif du sidecar désigne-t-il une config non approuvée ? */
export function motifDeScelle(motif: string | null): boolean {
  return motif !== null && motif.includes("hors de l'interface");
}

export const AVERTISSEMENT_BASH =
  "Bash activé : un message de l'émetteur écouté s'exécute sans validation sur ce poste, avec un shell complet dans ce projet.";

/** Valeurs de départ : celles de l'étude (docs/etude-veilleur-relais.md § 0). */
export const FORMULAIRE_DEFAUT: FormulaireVeilleur = {
  url: "",
  jetonSecret: "relais.jeton",
  expediteurs: "",
  modele: "claude-opus-5-5",
  effort: "medium",
  bash: false,
  profondeur: "6",
  coutParMessage: "5",
  toursParJour: "100",
  dureeMin: "20",
  cadenceSec: "30",
  proxy: "",
  ca: "",
  agent: "",
  actif: false,
};

/**
 * Formulaire d'après la config du fichier. Fichier NON approuvé (`scellee`
 * faux) : `actif` et `agent` n'en sont pas repris en silence — `actif: false`,
 * aucun agent ; l'encart dit ce qui diffère.
 */
export function formulaireDepuisConfig(c: ConfigVeilleur, scellee: boolean | null = true): FormulaireVeilleur {
  const fiable = scellee !== false;
  return {
    agent: fiable ? (c.agent ?? "") : "",
    actif: fiable ? c.actif : false,
    url: c.url,
    jetonSecret: c.jetonSecret,
    expediteurs: c.expediteurs.join(", "),
    modele: c.modele,
    effort: c.effort,
    bash: c.bash,
    profondeur: String(c.plafonds.profondeur),
    coutParMessage: String(c.plafonds.coutParMessage),
    toursParJour: String(c.plafonds.toursParJour),
    dureeMin: String(c.plafonds.dureeMin),
    cadenceSec: String(c.cadenceSec),
    proxy: c.proxy ?? "",
    ca: c.ca ?? "",
  };
}

function nombre(brut: string, nom: string, min: number, max: number, entier: boolean): number | string {
  const t = brut.trim().replace(",", ".");
  const v = Number(t);
  if (t === "" || !Number.isFinite(v)) return `${nom} : nombre attendu`;
  if (entier && !Number.isInteger(v)) return `${nom} : entier attendu`;
  if (v < min || v > max) return `${nom} : entre ${min} et ${max}`;
  return v;
}

/**
 * Config à envoyer, ou la première erreur. Tout ce qui sera scellé vient du
 * formulaire, `actif` et `agent` compris : rien n'est repris du disque en silence.
 */
export function configDepuisFormulaire(f: FormulaireVeilleur): { config: ConfigVeilleur } | { erreur: string } {
  const url = f.url.trim();
  if (!/^https:\/\//.test(url)) return { erreur: "Adresse du relais : https:// attendu" };
  const jetonSecret = f.jetonSecret.trim();
  if (!jetonSecret) return { erreur: "Nom du secret du coffre requis (le jeton lui-même n'est jamais saisi ici)" };
  const expediteurs = f.expediteurs.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (expediteurs.length === 0) return { erreur: "Au moins un émetteur écouté" };
  const mauvais = expediteurs.find((e) => !NOM_STUDIO.test(e));
  if (mauvais !== undefined) return { erreur: `Émetteur « ${mauvais} » : nom de boîte attendu (minuscules, chiffres, tirets ; 31 caractères au plus)` };
  if (!f.modele.trim()) return { erreur: "Modèle requis" };
  if (!f.effort.trim()) return { erreur: "Effort requis" };
  // Mêmes bornes que le sidecar (veilleurConfig.ts) : aucun « 0 = illimité ».
  const champs = [
    nombre(f.profondeur, "Allers-retours par fil", 1, 20, true),
    nombre(f.coutParMessage, "Coût par message ($)", 0, 50, false),
    nombre(f.toursParJour, "Tours par jour", 1, 500, true),
    nombre(f.dureeMin, "Durée d'un tour (min)", 1, 120, true),
    nombre(f.cadenceSec, "Cadence (s)", 10, 600, true),
  ];
  const erreur = champs.find((c): c is string => typeof c === "string");
  if (erreur) return { erreur };
  if ((champs[1] as number) <= 0) return { erreur: "Coût par message ($) : plus de 0 attendu" };
  const [profondeur, coutParMessage, toursParJour, dureeMin, cadenceSec] = champs as number[];
  return {
    config: {
      actif: f.actif,
      expediteurs,
      agent: f.agent.trim() || null,
      compte: "perso",
      modele: f.modele.trim(),
      effort: f.effort.trim(),
      permission: f.bash ? "bypassPermissions" : "acceptEdits",
      bash: f.bash,
      plafonds: { profondeur, coutParMessage, toursParJour, dureeMin },
      cadenceSec,
      url,
      jetonSecret,
      ...(f.proxy.trim() ? { proxy: f.proxy.trim() } : {}),
      ...(f.ca.trim() ? { ca: f.ca.trim() } : {}),
    },
  };
}

export type Ton = "ok" | "warn" | "bad" | "off";

/** Pastille et libellé d'un état. */
export function libelleEtat(etat: EtatVeilleur): { texte: string; ton: Ton } {
  switch (etat) {
    case "actif":
      return { texte: "actif", ton: "ok" };
    case "suspendu":
      return { texte: "suspendu", ton: "bad" };
    case "en-attente-coffre":
      return { texte: "en attente du coffre", ton: "warn" };
    case "invalide":
      return { texte: "invalide", ton: "bad" };
    case "arret-en-cours":
      return { texte: "arrêt en cours", ton: "warn" };
    case "bloque":
      return { texte: "bloqué (relancer l'application)", ton: "bad" };
    default:
      return { texte: "inactif", ton: "off" };
  }
}

/** Le statut parle-t-il de CE projet ? (un seul veilleur par poste) */
export function concerneLeProjet(s: StatutVeilleur | null, cwd: string | null): boolean {
  return s !== null && cwd !== null && s.cwd === cwd;
}

/** Nom court d'un projet (dernier segment du chemin). */
export function nomDuProjet(cwd: string): string {
  const morceaux = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return morceaux[morceaux.length - 1] || cwd;
}

/**
 * Texte de l'indicateur d'en-tête, ou `null` s'il n'y a rien à montrer
 * (inactif). Tout état autre qu'inactif se montre : un veilleur bloqué doit se voir.
 */
export function libelleIndicateur(s: StatutVeilleur | null): string | null {
  if (!s || s.etat === "inactif" || !s.cwd) return null;
  const nom = nomDuProjet(s.cwd);
  if (s.etat === "actif") return `Veilleur actif · ${nom}`;
  return `Veilleur ${libelleEtat(s.etat).texte} · ${nom}`;
}

/** Bilan de la dernière relève, en une ligne. */
export function resumeBilan(s: StatutVeilleur): string {
  const b = s.dernierBilan;
  if (!b) return "aucune relève encore";
  const parts = [
    b.traites.length > 0 ? `${b.traites.length} traité(s)` : "",
    b.refuses.length > 0 ? `${b.refuses.length} refusé(s)` : "",
    b.ignores.length > 0 ? `${b.ignores.length} laissé(s) en boîte` : "",
    b.invalides.length > 0 ? `${b.invalides.length} invalide(s)` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "boîte vide";
}

/** « 14:32:05 » d'une date ISO, ou « — ». */
export function heureDe(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("fr-FR");
}
