/*
 * Références de fichiers citées dans une transcription : ce qui est cliquable,
 * et ce que le clic doit faire (T-024, T-049).
 *
 * ── Pourquoi un module à part ───────────────────────────────────────────
 * La décision vivait dans deux endroits qui ne pouvaient pas se tester : une
 * heuristique de rendu au fond de `Markdown.tsx`, et 50 lignes de branches au
 * milieu d'`AgentPage.tsx`. Les deux répondaient à la MÊME question — « est-ce
 * que ce texte désigne quelque chose qu'on saura ouvrir ? » — sans jamais se
 * consulter. D'où le défaut d'origine : un `~/Téléchargements/x.pdf` devenait
 * un beau bouton, et le clic répondait « introuvable dans le projet » à propos
 * d'un fichier qui existe.
 *
 * Ici, une seule fonction classe la référence, et le rendu comme l'ouverture en
 * dérivent. Un bouton n'apparaît donc que là où le clic saura répondre.
 *
 * ── Ce que le classement NE fait pas ────────────────────────────────────
 * Il ne développe pas `~`. L'interface ne connaît pas le dossier personnel, et
 * l'inventer serait une devinette de plus ; surtout, un chemin hors projet ne
 * s'ouvre pas dans l'éditeur interne, c'est une règle du produit et non une
 * limite technique. `~/…` est donc traité comme un absolu hors projet : on le
 * NOMME, au lieu de prétendre l'avoir cherché.
 */

import { findAppForExtension, openExternal, readApps, type AppEntry } from "./appsAdmin";

export type ReferenceFichier =
  /** URL http(s) : rien à chercher sur le disque, ça part à l'extérieur. */
  | { genre: "distant"; url: string }
  /** Chemin absolu sous `cwd` : ouvrable directement. */
  | { genre: "projet"; chemin: string; nom: string }
  /** Chemin relatif comportant un `/` : à tenter depuis la racine du projet. */
  | { genre: "candidat"; chemin: string; nom: string }
  /** Nom simple : seule la recherche par nom de base peut trancher. */
  | { genre: "recherche"; nom: string }
  /** Absolu hors `cwd`, ou `~/…` : existe peut-être, mais pas ici. */
  | { genre: "hors-projet"; libelle: string };

/** `~` seul ou `~/…` — jamais `~ami/…`, qui ne nous concerne pas. */
function estCheminPersonnel(ref: string): boolean {
  return ref === "~" || ref.startsWith("~/");
}

export function estUrl(texte: string): boolean {
  return /^https?:\/\//i.test(texte);
}

/**
 * Nom de fichier porté par une URL, pour interroger le registre d'applications.
 *
 * Le dernier segment du CHEMIN, débarrassé de la requête et de l'ancre. Sans
 * ce découpage, `https://exemple.com` livrerait « com » comme extension et
 * pourrait déclencher une règle qui ne le vise pas — le registre est indexé par
 * extension, il n'a aucune idée de ce qu'est un domaine.
 */
export function nomDepuisUrl(url: string): string {
  const sansAncre = url.split("#")[0].split("?")[0];
  const apresSchema = sansAncre.replace(/^https?:\/\//i, "");
  const barre = apresSchema.indexOf("/");
  if (barre < 0) return ""; // pas de chemin : rien qu'un hôte
  return apresSchema.slice(barre + 1).split("/").at(-1) ?? "";
}

/** Nom de base d'un chemin (séparateur `/`, celui des références citées). */
function nomDeBase(ref: string): string {
  return ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
}

/**
 * Classe une référence citée dans une transcription, relativement au projet
 * ouvert. Pure : aucun accès disque — c'est l'appelant qui ira vérifier
 * l'existence du `candidat` ou lancer la `recherche`.
 */
export function classerReference(ref: string, cwd: string): ReferenceFichier {
  if (estUrl(ref)) return { genre: "distant", url: ref };

  if (estCheminPersonnel(ref)) return { genre: "hors-projet", libelle: ref };

  if (ref.startsWith("/")) {
    if (ref === cwd || ref.startsWith(`${cwd}/`)) {
      return { genre: "projet", chemin: ref, nom: nomDeBase(ref) || ref };
    }
    return { genre: "hors-projet", libelle: ref };
  }

  const nom = nomDeBase(ref);
  if (ref.includes("/")) return { genre: "candidat", chemin: `${cwd}/${ref}`, nom: nom || ref };
  return { genre: "recherche", nom };
}

/**
 * Habiller ce texte en bouton, ou le laisser en `code` inerte ?
 *
 * Un bouton qui ne peut rien ouvrir ment — c'est le second défaut de T-024, et
 * il est plus insidieux que le premier : le message trompeur, au moins, se
 * lit. Sont donc refusés `~/…` (non développable ici) et, dès que le projet
 * courant est connu, les absolus qui sortent de son arborescence. Les URL, en
 * revanche, sont acceptées DEPUIS T-049 : elles s'ouvrent à l'extérieur, donc
 * le bouton tient sa promesse.
 *
 * `cwd` inconnu (rendu hors projet) : on n'invente pas de refus — la référence
 * reste cliquable, et l'ouverture dira franchement « hors du projet ».
 */
export function estReferenceCliquable(texte: string, cwd?: string | null): boolean {
  if (!texte || texte.length > 120 || /\s/.test(texte)) return false;
  if (estUrl(texte)) return true;
  if (estCheminPersonnel(texte)) return false;
  if (texte.startsWith("/") && cwd) return texte === cwd || texte.startsWith(`${cwd}/`);
  if (texte.includes("/")) return true;
  return /\.[^./\s]{1,8}$/.test(texte);
}

/**
 * Application déclarée par l'utilisateur pour ce fichier, ou `null`.
 *
 * Le registre existait déjà (Configuration → Applications) mais SEUL l'arbre de
 * fichiers le consultait : le même fichier ouvert depuis l'arbre respectait la
 * règle, et l'ignorait depuis la transcription. C'est le manque principal de
 * T-049, et il dépasse le HTML — il vaut pour tout ce que l'utilisateur a
 * déclaré (pdf, odt, kicad…).
 */
export function appPour(apps: AppEntry[], nomOuUrl: string): AppEntry | null {
  const nom = estUrl(nomOuUrl) ? nomDepuisUrl(nomOuUrl) : nomDeBase(nomOuUrl);
  if (!nom) return null;
  return findAppForExtension(apps, nom);
}

/**
 * Ouvre un lien externe en passant par le registre : un `.html` cité dans un
 * rapport part dans le navigateur DÉCLARÉ, pas dans celui que le système a
 * décidé d'être le sien. Sans règle applicable, repli sur l'ouvreur du système
 * — c'est-à-dire le comportement d'avant, à l'octet près.
 */
export async function ouvrirLienExterne(href: string): Promise<void> {
  let commande: string | null = null;
  try {
    commande = appPour(await readApps(), href)?.command ?? null;
  } catch {
    // Registre illisible : ce n'est pas une raison pour ne pas ouvrir le lien.
  }
  await openExternal(href, commande);
}

/**
 * Ce dont l'ouverture a besoin du monde extérieur. Injecté plutôt qu'importé :
 * c'est ce qui rend le PARCOURS testable (absolu, relatif, recherche, échec de
 * recherche), et pas seulement le classement.
 */
export interface ContexteOuverture {
  cwd: string;
  apps: AppEntry[];
  /** Rejette si le chemin n'est pas lisible — seul son échec nous intéresse. */
  lireFichier: (chemin: string) => Promise<unknown>;
  chercherParNom: (racine: string, nom: string) => Promise<string[]>;
  ouvrirDansEditeur: (chemin: string, nom: string) => void;
  ouvrirDansApp: (chemin: string, commande: string) => Promise<void>;
  avis: (message: string | null) => void;
}

/** Registre d'abord, éditeur interne ensuite (T-049). */
async function ouvrirSelonRegistre(chemin: string, nom: string, ctx: ContexteOuverture): Promise<void> {
  const app = appPour(ctx.apps, nom);
  if (!app) {
    ctx.ouvrirDansEditeur(chemin, nom);
    return;
  }
  try {
    await ctx.ouvrirDansApp(chemin, app.command);
  } catch (err) {
    ctx.avis(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Dernier recours : le nom de base, cherché dans le projet. C'est la seule
 * branche qui peut légitimement conclure « introuvable » — les autres savent
 * dire mieux, et c'était tout le défaut de T-024.
 */
async function ouvrirParRecherche(ref: string, nom: string, ctx: ContexteOuverture): Promise<void> {
  try {
    const trouves = await ctx.chercherParNom(ctx.cwd, nom);
    if (trouves.length === 0) {
      ctx.avis(`« ${ref} » introuvable dans le projet.`);
      return;
    }
    const [premier, ...reste] = trouves;
    await ouvrirSelonRegistre(premier, premier.slice(premier.lastIndexOf("/") + 1), ctx);
    if (reste.length > 0) {
      ctx.avis(
        `${reste.length} autre${reste.length > 1 ? "s" : ""} correspondance${reste.length > 1 ? "s" : ""} pour « ${ref} ».`,
      );
    }
  } catch (err) {
    ctx.avis(`Recherche impossible pour « ${ref} » : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Le parcours complet d'un clic sur une référence citée. Rend la main quand
 * l'ouverture est lancée (le spawn externe, lui, est détaché).
 */
export async function ouvrirReference(ref: string, ctx: ContexteOuverture): Promise<void> {
  ctx.avis(null);
  const classe = classerReference(ref, ctx.cwd);

  if (classe.genre === "hors-projet") {
    ctx.avis(`Fichier hors du projet : ${classe.libelle}`);
    return;
  }
  if (classe.genre === "distant") {
    try {
      await ouvrirLienExterne(classe.url);
    } catch (err) {
      ctx.avis(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (classe.genre === "projet") {
    await ouvrirSelonRegistre(classe.chemin, classe.nom, ctx);
    return;
  }
  if (classe.genre === "candidat") {
    try {
      await ctx.lireFichier(classe.chemin);
      await ouvrirSelonRegistre(classe.chemin, classe.nom, ctx);
      return;
    } catch {
      // Inexistant depuis la racine du projet : repli sur la recherche par nom.
    }
  }

  if (!classe.nom) {
    ctx.avis(`« ${ref} » introuvable dans le projet.`);
    return;
  }
  await ouvrirParRecherche(ref, classe.nom, ctx);
}
