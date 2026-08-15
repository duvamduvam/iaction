/*
 * Réglages réseau d'entreprise (T-045) : lecture, validation, écriture.
 *
 * ── Ce que ces quatre champs réparent ───────────────────────────────────
 * T-043 a réparé le cas courant — un proxy déjà posé dans l'environnement —
 * en une ligne. Il laissait trois trous, et celui qu'on comble ici est le plus
 * bête : **il n'y avait aucun endroit où saisir un proxy**. Sous Windows, les
 * variables vivent souvent dans le profil du terminal et non dans la session
 * graphique ; il fallait passer par `setx`, ce qu'aucune documentation ne
 * disait. Un poste d'entreprise était donc utilisable « par accident ».
 *
 * ── Ce que ces réglages NE font pas, et qu'il faut dire ─────────────────
 * Le PAC (`AutoConfigURL` du registre Windows) n'est toujours pas interprété :
 * un poste qui n'a que ça doit saisir son proxy ici, à la main. Le prétendre
 * automatique serait pire que de l'avouer.
 *
 * Config NON SECRÈTE (clé `reseau`) : une adresse de proxy n'est pas un
 * secret, et la mettre au trousseau la rendrait invisible au moment où on la
 * cherche. Une URL avec mot de passe (`http://user:pass@proxy`) est acceptée
 * telle quelle — c'est la forme que le poste utilise déjà —, et c'est
 * précisément pourquoi l'encart le signale à l'écran.
 */
import { readConfig, writeConfig } from "./appConfig";

export interface ReglagesReseau {
  /** Proxy explicite (`http://hote:port`), appliqué à HTTP et HTTPS. */
  proxy: string;
  /** Hôtes joints en direct, séparés par des virgules (`NO_PROXY`). */
  sansProxy: string;
  /** Chemin d'un fichier PEM d'autorité supplémentaire (`NODE_EXTRA_CA_CERTS`). */
  autorite: string;
  /** Lire aussi le magasin de certificats du système (`--use-system-ca`). */
  caSysteme: boolean;
}

export const RESEAU_VIDE: ReglagesReseau = { proxy: "", sansProxy: "", autorite: "", caSysteme: false };

function chaine(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Lecture tolérante : tout champ absent ou mal typé vaut « pas de réglage ». */
export function lireReglages(brut: unknown): ReglagesReseau {
  if (typeof brut !== "object" || brut === null) return RESEAU_VIDE;
  const v = brut as Record<string, unknown>;
  return {
    proxy: chaine(v.proxy),
    sansProxy: chaine(v.sansProxy),
    autorite: chaine(v.autorite),
    caSysteme: v.caSysteme === true,
  };
}

/**
 * Forme écrite dans la config : les champs vides sont OMIS, pas écrits vides.
 *
 * Une clé `reseau: {}` et une clé absente doivent produire exactement le même
 * environnement — c'est ce que la coquille vérifie de son côté (`reseau.rs`),
 * et le seul moyen de garantir qu'un formulaire ouvert puis refermé sans rien
 * saisir ne change rien.
 */
export function versConfig(r: ReglagesReseau): Record<string, unknown> {
  return {
    ...(r.proxy ? { proxy: r.proxy } : {}),
    ...(r.sansProxy ? { sansProxy: r.sansProxy } : {}),
    ...(r.autorite ? { autorite: r.autorite } : {}),
    ...(r.caSysteme ? { caSysteme: true } : {}),
  };
}

/**
 * Avertissement affiché sous le champ proxy — `null` quand il n'y a rien à
 * dire. On ne REFUSE pas une saisie : un proxy d'entreprise peut prendre des
 * formes que nous ne connaissons pas, et bloquer l'utilisateur sur une règle
 * devinée serait pire que de le laisser essayer. On signale, il tranche.
 */
export function avertissementProxy(proxy: string): string | null {
  const v = proxy.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) {
    return "Un proxy s'écrit avec son schéma : http://hote:port (https:// est accepté aussi).";
  }
  if (/^[^/]*\/\/[^@/]*:[^@/]*@/.test(v)) {
    return "Cette adresse contient un mot de passe. Elle est enregistrée en clair dans la configuration, comme une variable d'environnement — pas dans le trousseau.";
  }
  return null;
}

/** Les réglages réseau du poste (clé `reseau` de la config non secrète). */
export async function readReseau(): Promise<ReglagesReseau> {
  return lireReglages((await readConfig()).reseau);
}

/**
 * Écrit les réglages. Ils ne prennent effet qu'au (re)démarrage du sidecar :
 * `--use-env-proxy` et `--use-system-ca` sont lus par Node au lancement du
 * process, pas à chaque requête. L'encart le dit à l'utilisateur au lieu de le
 * laisser croire à un effet immédiat.
 */
export async function writeReseau(r: ReglagesReseau): Promise<void> {
  await writeConfig({ reseau: versConfig(r) });
}
