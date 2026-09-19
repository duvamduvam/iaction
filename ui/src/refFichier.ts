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
 * ── `~` : demandé au système, jamais deviné (T-107) ─────────────────────
 * Jusqu'à T-107, ce module affirmait ne pas développer `~` au motif que
 * « l'interface ne connaît pas le dossier personnel, et l'inventer serait une
 * devinette de plus ». La seconde moitié était une erreur de fait : personne
 * n'a besoin d'INVENTER quoi que ce soit, `homeDir()` de
 * `@tauri-apps/api/path` (voir `dossierPersonnel.ts`) le DEMANDE au système.
 * Ce qui n'a pas changé : sans réponse (hors Tauri, ou dossier personnel
 * encore inconnu au moment du clic), on ne prétend toujours rien — `~/…` se
 * nomme au lieu de s'ouvrir, exactement comme avant ce ticket. Développé, un
 * `~/…` devient un chemin comme un autre et suit la même cascade que
 * n'importe quel absolu (projet, ou hors projet via `basesDuFil`, T-105).
 *
 * Un chemin hors projet n'est plus systématiquement REFUSÉ depuis T-105 :
 * l'éditeur interne, lui, reste borné au projet — règle du produit et non
 * limite technique (T-024), rien ici ne la lève. Mais l'application que
 * l'utilisateur a DÉCLARÉE pour ce type de fichier n'a aucune raison d'être
 * bornée pareil : passer un `.stl` écrit hors du projet à Cura ne concerne
 * pas l'éditeur interne. Le chemin part donc vers l'application déclarée,
 * ou, à défaut, vers l'ouvreur du SYSTÈME (T-106) — il n'existe plus de type
 * qui n'ait aucune issue.
 *
 * ── Pourquoi un absolu hors projet redevient cliquable (T-106) ──────────
 * Le refus datait d'une époque où la seule ouverture possible était
 * l'éditeur interne, borné au projet : montrer un bouton pour un chemin
 * qu'aucune de ces trois voies ne pouvait honorer aurait été le même
 * mensonge que celui que ce module existe pour empêcher. Depuis que
 * l'ouvreur système ferme la cascade (T-106), CE mensonge n'a plus de prise
 * : une règle déclarée, l'éditeur interne dans le projet, ou le système
 * partout ailleurs — il existe toujours une issue, donc la promesse tient.
 * Seul `~/…` reste refusé quand le dossier personnel est INCONNU (T-107) :
 * aucune des trois voies ne sait quoi faire d'un chemin qu'on ne sait pas
 * résoudre. Développé, c'est un absolu comme un autre — même cascade.
 *
 * ── Résolution et action, séparées (T-108) ───────────────────────────────
 * Le clic gauche résolvait ET ouvrait d'un seul geste — `ouvrirReference`
 * mêlait les deux. Un menu contextuel (clic droit, voir `menuReference.tsx`)
 * a besoin de la résolution SEULE, avant d'afficher quoi que ce soit :
 * `resoudreReference` porte ce parcours (identique à l'ancien, disque
 * compris), `ouvrirReference` n'est plus que « résoudre, puis agir » selon
 * la politique par défaut — ou celle imposée par `ContexteOuverture.forcer`.
 */

import { findAppForExtension, openExternal, readApps, type AppEntry } from "./appsAdmin";
import { asRecord } from "./base";
import { dossierPersonnel } from "./dossierPersonnel";
import type { AgentTurn } from "./agentTurns";

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

/**
 * Développe `~` en tête de chemin vers le dossier personnel (T-107). Pure :
 * `home` à `null` (dossier personnel inconnu) laisse le texte inchangé — on
 * ne DEVINE toujours rien, ce ticket corrige seulement le refus de DEMANDER.
 * Jamais `~ami/…`, même règle qu'`estCheminPersonnel`.
 */
export function developperTilde(ref: string, home: string | null): string {
  if (home === null) return ref;
  if (ref === "~") return home;
  if (ref.startsWith("~/")) return `${home}/${ref.slice(2)}`;
  return ref;
}

export function estUrl(texte: string): boolean {
  return /^https?:\/\//i.test(texte);
}

/*
 * Un nom d'hôte cité SANS schéma — `secure.exemple.fr`, `www.exemple.com/x`.
 *
 * Sans cette reconnaissance, `secure.exemple.fr` tombait dans la branche
 * « recherche » : `.fr` ressemble à une extension, donc le texte devenait un
 * bouton, et le clic répondait « introuvable dans le projet » à propos d'un
 * site web (T-090). C'est exactement le mensonge que ce module existe pour
 * empêcher, à un détail près — ici le bouton a raison d'exister, c'est sa
 * DESTINATION qui était fausse.
 *
 * Départager un hôte d'un fichier ne peut pas se faire sur la forme seule :
 * `notes.md` et `exemple.fr` sont indistinguables. On tranche donc sur le
 * dernier segment, et uniquement sur une liste de domaines de premier niveau
 * dont aucune extension de fichier courante ne porte le nom. En cas de doute
 * — `.ai` (Illustrator), `.sh`, `.rs`, `.py`, tous TLD par ailleurs — on ne
 * décide PAS : le fichier garde la priorité, et le comportement d'avant reste
 * celui du projet ouvert.
 */
const TLD_JAMAIS_EXTENSION = new Set([
  "be", "biz", "ca", "ch", "com", "de", "edu", "es", "eu", "fr",
  "gouv", "gov", "info", "io", "it", "net", "nl", "org", "uk",
]);

export function estNomDHote(texte: string): boolean {
  const hote = texte.split("/")[0];
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(hote)) return false;
  return TLD_JAMAIS_EXTENSION.has(hote.slice(hote.lastIndexOf(".") + 1).toLowerCase());
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

/** Barre finale retirée, sauf pour la racine `/` elle-même. */
function sansBarreFinale(rep: string): string {
  return rep.length > 1 && rep.endsWith("/") ? rep.slice(0, -1) : rep;
}

/**
 * Répertoire parent d'un chemin ABSOLU (pas de résolution de `..`, inutile
 * ici). Exportée pour « Ouvrir le dossier » du menu contextuel (T-108).
 */
export function repertoireParent(cheminAbsolu: string): string {
  const sans = sansBarreFinale(cheminAbsolu);
  const barre = sans.lastIndexOf("/");
  return sansBarreFinale(barre <= 0 ? "/" : sans.slice(0, barre));
}

/**
 * Jetons ABSOLUS d'une commande shell — cible d'un `cd`, destination d'un
 * `mv`/`cp`, fichier d'une redirection `>` ou d'un `-o`… tout jeton qui
 * COMMENCE par `/` une fois les guillemets simples ou doubles retirés (T-106),
 * ou par `~/` développé quand le dossier personnel est connu (T-107) — le cas
 * réel du ticket, `cd ~/Nextcloud/…`. Les jetons relatifs sont ignorés, `cd`
 * compris : on ne devine pas depuis où ils partent, et un `~/…` reste ignoré
 * tant que `home` est `null` (comportement d'avant T-107, à l'identique). Un
 * motif comme `sed 's/a/b/'` ne matche jamais : une fois les guillemets
 * retirés, `s/a/b/` ne commence pas par `/`, et `2>&1` non plus.
 */
function jetonsAbsolus(commande: string, home: string | null): string[] {
  const jetons: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  for (let m = re.exec(commande); m; m = re.exec(commande)) {
    const brut = m[0];
    const jeton = /^["'].*["']$/.test(brut) ? brut.slice(1, -1) : brut;
    if (jeton.startsWith("/")) jetons.push(jeton);
    else if (estCheminPersonnel(jeton)) {
      const developpe = developperTilde(jeton, home);
      if (developpe.startsWith("/")) jetons.push(developpe);
    }
  }
  return jetons;
}

/**
 * Répertoire porté par un jeton absolu : son PARENT si le dernier segment a
 * un point — un FICHIER, cible de `mv`, `-o`, redirection… — ou le chemin
 * lui-même sinon, cas d'un répertoire (`cd /a/b` compris).
 */
function repertoireDuJeton(jeton: string): string {
  const sans = sansBarreFinale(jeton);
  const dernierSegment = sans.slice(sans.lastIndexOf("/") + 1);
  return dernierSegment.includes(".") ? repertoireParent(sans) : sans;
}

/** Répertoires absolus tirés d'un seul bloc d'outil (forme libre, ne jette jamais). */
function repertoiresDuBloc(toolInput: unknown, home: string | null): string[] {
  const input = asRecord(toolInput);
  const reps: string[] = [];
  for (const champ of ["file_path", "path", "notebook_path"]) {
    const brut = input[champ];
    if (typeof brut !== "string") continue;
    const valeur = estCheminPersonnel(brut) ? developperTilde(brut, home) : brut;
    if (valeur.startsWith("/")) reps.push(repertoireParent(valeur));
  }
  if (typeof input.command === "string") {
    for (const jeton of jetonsAbsolus(input.command, home)) reps.push(repertoireDuJeton(jeton));
  }
  return reps;
}

/**
 * Répertoires absolus vus dans le fil, du plus récent au plus ancien (T-105).
 *
 * Le modèle dit où il travaille — `cd` dans ses `Bash`, mais aussi tout
 * chemin absolu qu'une commande manipule (`mv`/`cp`, redirection, `-o` —
 * un fichier RANGÉ l'est par une commande, T-106), et `file_path` de ses
 * `Read`/`Edit`/`Write` — avant même de citer une référence relative à ce
 * répertoire. Cette fonction rend ces répertoires disponibles à la
 * résolution ; elle ne résout rien elle-même, et ne touche pas au disque.
 *
 * `home` développe les jetons et `file_path` en `~/…` (T-107) — `null` pour
 * un dossier personnel encore inconnu, auquel cas ils sont ignorés comme
 * avant ce ticket.
 */
export function basesDuFil(turns: readonly AgentTurn[], home: string | null, max = 12): string[] {
  const vus: string[] = [];
  const dejaVu = new Set<string>();
  parcours: for (let i = turns.length - 1; i >= 0; i--) {
    const blocs = turns[i]?.blocks ?? [];
    for (let j = blocs.length - 1; j >= 0; j--) {
      const bloc = blocs[j];
      if (bloc.type !== "tool") continue;
      for (const rep of repertoiresDuBloc(bloc.toolInput, home)) {
        if (dejaVu.has(rep)) continue;
        dejaVu.add(rep);
        vus.push(rep);
        if (vus.length >= max) break parcours;
      }
    }
  }
  return vus;
}

/**
 * Classe une référence citée dans une transcription, relativement au projet
 * ouvert. Pure : aucun accès disque — c'est l'appelant qui ira vérifier
 * l'existence du `candidat` ou lancer la `recherche`.
 *
 * `home` développe le tilde D'ABORD (T-107) : un `~/…` sous la racine du
 * projet devient donc un `projet` ordinaire, et ailleurs un `hors-projet`
 * portant le vrai chemin — plus un libellé qu'on ne sait pas ouvrir. `home`
 * inconnu (`undefined` ou `null`) laisse `~/…` inchangé, comportement
 * d'avant ce ticket.
 */
export function classerReference(ref: string, cwd: string, home?: string | null): ReferenceFichier {
  if (estUrl(ref)) return { genre: "distant", url: ref };
  // Un hôte sans schéma part quand même à l'extérieur : `https` est le défaut
  // du web depuis longtemps, et c'est la seule lecture qui tienne sa promesse.
  if (estNomDHote(ref)) return { genre: "distant", url: `https://${ref}` };

  const developpe = developperTilde(ref, home ?? null);

  if (estCheminPersonnel(developpe)) return { genre: "hors-projet", libelle: developpe };

  /*
   * Barre finale retirée AVANT tout le reste (T-119) : `plans/supports/x/`
   * et `plans/supports/x` désignent la même chose, et seul le second donnait
   * un nom de base utilisable — le premier livrait `nomDeBase` vide, donc un
   * `nom` valant le chemin entier, cherché tel quel par nom de base. C'est ce
   * qui faisait répondre « introuvable dans le projet » à propos d'un dossier
   * qui existe. La barre reste MÉMORISÉE (`finitParBarre`) : elle est le seul
   * indice de forme qui dise « ceci est un dossier », et elle suffit à faire
   * d'un `photos/` sans autre barre un chemin à tenter sous la racine plutôt
   * qu'un nom à chercher partout.
   */
  const finitParBarre = developpe.length > 1 && developpe.endsWith("/");
  const sansBarre = sansBarreFinale(developpe);

  if (sansBarre.startsWith("/")) {
    if (sansBarre === cwd || sansBarre.startsWith(`${cwd}/`)) {
      return { genre: "projet", chemin: sansBarre, nom: nomDeBase(sansBarre) || sansBarre };
    }
    return { genre: "hors-projet", libelle: sansBarre };
  }

  const nom = nomDeBase(sansBarre);
  if (sansBarre.includes("/") || finitParBarre) {
    return { genre: "candidat", chemin: `${cwd}/${sansBarre}`, nom: nom || sansBarre };
  }
  return { genre: "recherche", nom };
}

/**
 * Habiller ce texte en bouton, ou le laisser en `code` inerte ?
 *
 * Un bouton qui ne peut rien ouvrir ment — c'est le second défaut de T-024, et
 * il est plus insidieux que le premier : le message trompeur, au moins, se
 * lit. `~/…` n'est refusé QUE quand le dossier personnel est inconnu (T-107)
 * : sans lui, aucune des trois voies d'ouverture (registre, éditeur interne,
 * système) ne sait quoi en faire — la promesse ne doit jamais dépasser ce
 * qu'on sait tenir. Connu, un `~/…` est un absolu comme un autre, et le reste
 * de la cascade s'applique : un absolu hors projet N'EST PLUS refusé depuis
 * T-106 (`ouvrirSelonRegistre` se ferme sur l'ouvreur du système), donc il
 * existe toujours une issue. Les URL, depuis T-049, tiennent la même
 * promesse en s'ouvrant à l'extérieur.
 *
 * `cwd` n'a plus de rôle ici (T-106) : il ne reste conservé dans la
 * signature que parce que l'appelant (`Markdown.tsx`) le fournit encore ;
 * garder le paramètre évite un remaniement hors du périmètre de ce ticket.
 */
export function estReferenceCliquable(texte: string, _cwd?: string | null, home?: string | null): boolean {
  if (!texte || texte.length > 120 || /\s/.test(texte)) return false;
  if (estUrl(texte)) return true;
  if (estNomDHote(texte)) return true;
  if (estCheminPersonnel(texte)) return home !== undefined && home !== null;
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

/*
 * ── Séparer la RÉSOLUTION de l'ACTION (T-108) ─────────────────────────────
 * `ouvrirReference` faisait les deux d'un seul mouvement : sonder le disque
 * ET agir. Un menu contextuel a besoin de la résolution SEULE, avant
 * d'afficher quoi que ce soit — pour savoir s'il propose « Ouvrir avec Cura »
 * (une règle s'applique), l'éditeur interne (le fichier est-il sous le
 * projet ?), ou pour dire franchement « introuvable » dans le menu plutôt
 * qu'après coup. `resoudreReference` reprend tout le parcours de recherche
 * (dossier personnel, classement, racine du projet, bases du fil, recherche
 * par nom) et REND son résultat au lieu d'ouvrir ; `ouvrirReference` n'est
 * plus que « résoudre, puis agir », avec la politique par défaut inchangée.
 */
export type ResolutionReference =
  /** Un fichier atteint sur le disque. `sousProjet` décide de l'éditeur interne. */
  | { etat: "fichier"; chemin: string; nom: string; sousProjet: boolean; autres: number }
  /**
   * Un DOSSIER atteint sur le disque (T-119). Jusqu'ici la résolution ne
   * savait sonder que des fichiers : `plans/supports/support-camera-csi/`
   * épuisait la cascade et finissait « introuvable dans le projet » à propos
   * d'un dossier bien présent — le mensonge exact que ce module existe pour
   * empêcher. Un dossier n'a ni règle d'application ni éditeur interne : sa
   * seule voie est l'ouvreur du SYSTÈME, qui pour un répertoire est le
   * gestionnaire de fichiers. Pas de champ `autres` : on ne cherche jamais un
   * dossier par nom de base, donc il n'y a pas d'autres correspondances à
   * annoncer.
   */
  | { etat: "dossier"; chemin: string; nom: string; sousProjet: boolean }
  /** URL ou nom d'hôte : rien à résoudre, ça part à l'extérieur. */
  | { etat: "distant"; url: string }
  /** Rien à ouvrir, avec la raison EXACTE que l'ancien `ouvrirReference` disait déjà. */
  | { etat: "impossible"; message: string };

/**
 * Forçage demandé par le menu contextuel (T-108) — absent, c'est la politique
 * par défaut du clic gauche, inchangée :
 *  - "app"     : l'application déclarée si une règle existe, sinon l'ouvreur
 *                du système — jamais l'éditeur, même sous le projet ;
 *  - "systeme" : toujours l'ouvreur du système, règle déclarée ignorée ;
 *  - "editeur" : l'éditeur interne, et UNIQUEMENT si le fichier est sous le
 *                projet — il reste borné au projet, règle de produit (T-024)
 *                que ce ticket ne lève pas.
 */
export type ForcageOuverture = "app" | "systeme" | "editeur";

/**
 * Ce dont l'ouverture a besoin du monde extérieur. Injecté plutôt qu'importé :
 * c'est ce qui rend le PARCOURS testable (absolu, relatif, recherche, échec de
 * recherche), et pas seulement le classement.
 */
export interface ContexteOuverture {
  cwd: string;
  /**
   * Tours de la conversation, d'où `ouvrirReference` tire lui-même les
   * répertoires supplémentaires où tenter un relatif (`basesDuFil`, T-105).
   * Pas un `bases?: string[]` calculé par l'appelant (T-107) : le
   * développement des `~/…` qu'ils peuvent contenir dépend du dossier
   * personnel, connu seulement en asynchrone — c'est `ouvrirReference`, qui
   * peut l'attendre, qui calcule les bases, pas l'appelant.
   */
  turns?: readonly AgentTurn[];
  apps: AppEntry[];
  /**
   * Impose une voie plutôt que de laisser la politique par défaut décider
   * (menu contextuel, T-108). Absent : comportement d'aujourd'hui, à
   * l'identique — c'est `resoudreReference` qui reste seul maître de savoir
   * QUOI ouvrir, `forcer` ne décide que du COMMENT.
   */
  forcer?: ForcageOuverture;
  /** Rejette si le chemin n'est pas lisible — seul son échec nous intéresse. */
  lireFichier: (chemin: string) => Promise<unknown>;
  /**
   * Rejette si le chemin n'est pas un dossier lisible (T-119) — comme
   * `lireFichier`, seul son échec nous intéresse : c'est la sonde qui
   * distingue un dossier d'un fichier, et il n'existe pas d'autre moyen de
   * le faire honnêtement (la forme du chemin ne prouve rien — `Makefile`
   * n'a pas de point, `v1.2` en a un).
   */
  listerDossier: (chemin: string) => Promise<unknown>;
  chercherParNom: (racine: string, nom: string) => Promise<string[]>;
  ouvrirDansEditeur: (chemin: string, nom: string) => void;
  /** `commande: null` ⇒ ouvreur du système, faute de règle applicable (T-106). */
  ouvrirDansApp: (chemin: string, commande: string | null) => Promise<void>;
  avis: (message: string | null) => void;
  /**
   * Dossier personnel injecté : s'il est fourni (même `null`), PRIME sur
   * l'appel système — c'est ce qui rend le parcours testable sans Tauri
   * (T-107). Omis : `ouvrirReference` le demande lui-même.
   */
  home?: string | null;
}

/** Le chemin est-il `cwd` lui-même ou un de ses descendants ? */
function sousRacine(chemin: string, cwd: string): boolean {
  return chemin === cwd || chemin.startsWith(`${cwd}/`);
}

/**
 * Ce chemin est-il un DOSSIER lisible (T-119) ? Une sonde, pas une devinette :
 * on demande au disque plutôt que de lire la forme du nom. Ne jette jamais —
 * un refus (inexistant, fichier, permission) répond simplement « non », et la
 * cascade continue exactement comme avant ce ticket.
 */
async function estDossier(chemin: string, ctx: ContexteOuverture): Promise<boolean> {
  try {
    await ctx.listerDossier(chemin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Le parcours de RÉSOLUTION seul (T-108) : classement, racine du projet,
 * bases du fil (T-105), recherche par nom — repris à l'identique de
 * l'ancien `ouvrirReference`, à ceci près qu'il REND le résultat au lieu
 * d'agir. Aucun accès en ÉCRITURE ni ouverture d'application : seuls
 * `ctx.lireFichier` (sonder l'existence) et `ctx.chercherParNom` sont
 * appelés, jamais `ctx.ouvrirDansApp`/`ouvrirDansEditeur`/`avis`.
 */
export async function resoudreReference(ref: string, ctx: ContexteOuverture): Promise<ResolutionReference> {
  // Le dossier personnel n'est connu qu'en asynchrone (T-107) : `ctx.home`,
  // s'il est fourni, PRIME sur l'appel système — c'est ce qui rend ce
  // parcours testable sans Tauri. Tout ce qui suit (classement, bases,
  // résolution) en découle.
  const home = ctx.home !== undefined ? ctx.home : await dossierPersonnel();
  const classe = classerReference(ref, ctx.cwd, home);
  const bases = basesDuFil(ctx.turns ?? [], home);

  if (classe.genre === "distant") return { etat: "distant", url: classe.url };

  if (classe.genre === "hors-projet") {
    /*
     * Un absolu hors projet a toujours une issue (registre puis système,
     * T-105/T-106) — sauf `~/…` quand le dossier personnel reste INCONNU
     * (T-107) : le tilde n'a alors pas pu être développé, et tendre un
     * fichier nommé « ~ » à une application échouerait sur un message
     * obscur. C'est le SEUL chemin qu'on sait ne pas savoir résoudre, et il
     * se NOMME plutôt que de s'ouvrir — la doctrine du module, inchangée
     * depuis T-024. Développé, ce n'est plus un `~/…` mais un absolu réel :
     * cette garde ne se déclenche alors jamais.
     */
    if (estCheminPersonnel(classe.libelle)) {
      return { etat: "impossible", message: `Fichier hors du projet : ${classe.libelle}` };
    }
    const nom = nomDeBase(classe.libelle) || classe.libelle;
    if (await estDossier(classe.libelle, ctx)) {
      return { etat: "dossier", chemin: classe.libelle, nom, sousProjet: false };
    }
    return { etat: "fichier", chemin: classe.libelle, nom, sousProjet: false, autres: 0 };
  }

  if (classe.genre === "projet") {
    if (await estDossier(classe.chemin, ctx)) {
      return { etat: "dossier", chemin: classe.chemin, nom: classe.nom, sousProjet: true };
    }
    return { etat: "fichier", chemin: classe.chemin, nom: classe.nom, sousProjet: true, autres: 0 };
  }

  if (classe.genre === "candidat") {
    try {
      await ctx.lireFichier(classe.chemin);
      return { etat: "fichier", chemin: classe.chemin, nom: classe.nom, sousProjet: true, autres: 0 };
    } catch {
      // Inexistant depuis la racine du projet : on tente les répertoires vus
      // dans le fil (T-105), le plus récent d'abord, avant la recherche.
    }
    // Illisible comme fichier ne veut pas dire absent : un DOSSIER échoue à la
    // lecture (T-119). On le sonde avant d'aller chercher ailleurs.
    if (await estDossier(classe.chemin, ctx)) {
      return { etat: "dossier", chemin: classe.chemin, nom: classe.nom, sousProjet: true };
    }
    /*
     * Le relatif tel qu'il sera tenté sous chaque base : celui du CANDIDAT, pas
     * `ref` brut — c'est lui qui porte la normalisation (barre finale, tilde
     * développé), et coller `ref` à une base ferait resurgir sous les autres
     * répertoires le défaut qu'on vient de corriger sous la racine.
     */
    const relatif = classe.chemin.slice(ctx.cwd.length + 1);
    for (const base of bases) {
      const chemin = `${base}/${relatif}`;
      try {
        await ctx.lireFichier(chemin);
      } catch {
        if (await estDossier(chemin, ctx)) {
          return { etat: "dossier", chemin, nom: classe.nom, sousProjet: sousRacine(chemin, ctx.cwd) };
        }
        continue; // Ni fichier ni dossier sous cette base : suivante.
      }
      return { etat: "fichier", chemin, nom: classe.nom, sousProjet: sousRacine(chemin, ctx.cwd), autres: 0 };
    }
    // Épuisé : bascule sur la recherche par nom, exactement comme un genre
    // « recherche » (le code qui suit ne distingue plus les deux).
  }

  const nom = classe.nom;
  if (!nom) return { etat: "impossible", message: `« ${ref} » introuvable dans le projet.` };

  /*
   * Dernier recours : le nom de base, cherché dans le projet, puis sous les
   * répertoires vus dans le fil (T-105) — le modèle a pu écrire ce fichier
   * ailleurs et le citer sans chemin. « introuvable » n'est conclu qu'après
   * avoir épuisé les deux ; c'était tout le défaut de T-024.
   */
  try {
    const trouves = await ctx.chercherParNom(ctx.cwd, nom);
    if (trouves.length > 0) {
      const [premier, ...reste] = trouves;
      return { etat: "fichier", chemin: premier, nom: nomDeBase(premier), sousProjet: true, autres: reste.length };
    }
    for (const base of bases) {
      const chemin = `${base}/${nom}`;
      try {
        await ctx.lireFichier(chemin);
      } catch {
        continue; // Absent sous cette base : suivante.
      }
      return { etat: "fichier", chemin, nom, sousProjet: sousRacine(chemin, ctx.cwd), autres: 0 };
    }
    return { etat: "impossible", message: `« ${ref} » introuvable dans le projet.` };
  } catch (err) {
    return {
      etat: "impossible",
      message: `Recherche impossible pour « ${ref} » : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Applique la politique d'ouverture à un fichier RÉSOLU. Sans `ctx.forcer` :
 * registre d'abord, éditeur interne ensuite si sous le projet (T-024), sinon
 * l'ouvreur du SYSTÈME (T-106) — la politique du clic gauche, inchangée.
 * `ctx.forcer` (menu contextuel, T-108) impose une voie plutôt que de
 * laisser cette cascade décider — voir la doctrine de `ForcageOuverture`.
 */
async function appliquerResolution(
  res: Extract<ResolutionReference, { etat: "fichier" }>,
  ctx: ContexteOuverture,
): Promise<void> {
  if (ctx.forcer === "systeme") {
    try {
      await ctx.ouvrirDansApp(res.chemin, null);
    } catch (err) {
      ctx.avis(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (ctx.forcer === "editeur") {
    if (!res.sousProjet) {
      // Message pour un humain : il dit ce qui bloque et ce qui reste possible.
      // Pas de numéro de ticket ici — aucun autre avis du produit n'en porte,
      // et « T-024 » ne veut rien dire pour qui lit la transcription.
      ctx.avis(`L'éditeur interne n'ouvre que les fichiers du projet. Hors du projet : ${res.chemin}`);
      return;
    }
    ctx.ouvrirDansEditeur(res.chemin, res.nom);
    return;
  }
  const app = appPour(ctx.apps, res.nom);
  if (app) {
    try {
      await ctx.ouvrirDansApp(res.chemin, app.command);
    } catch (err) {
      ctx.avis(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (ctx.forcer === undefined && res.sousProjet) {
    ctx.ouvrirDansEditeur(res.chemin, res.nom);
    return;
  }
  try {
    await ctx.ouvrirDansApp(res.chemin, null);
  } catch (err) {
    ctx.avis(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Le parcours complet d'un clic sur une référence citée : résoudre, puis
 * agir. Rend la main quand l'ouverture est lancée (le spawn externe, lui,
 * est détaché).
 */
export async function ouvrirReference(ref: string, ctx: ContexteOuverture): Promise<void> {
  ctx.avis(null);
  const resolution = await resoudreReference(ref, ctx);

  if (resolution.etat === "impossible") {
    ctx.avis(resolution.message);
    return;
  }
  if (resolution.etat === "distant") {
    try {
      await ouvrirLienExterne(resolution.url);
    } catch (err) {
      ctx.avis(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  /*
   * Un dossier n'a qu'une voie (T-119) : l'ouvreur du SYSTÈME, qui pour un
   * répertoire est le gestionnaire de fichiers. Ni registre d'applications
   * (il est indexé par extension, un dossier n'en a pas), ni éditeur interne
   * (il ouvre des fichiers). `ctx.forcer` ne change donc rien ici — il n'y a
   * pas de cascade à imposer, seulement l'unique issue qui existe.
   */
  if (resolution.etat === "dossier") {
    try {
      await ctx.ouvrirDansApp(resolution.chemin, null);
    } catch (err) {
      ctx.avis(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  await appliquerResolution(resolution, ctx);
  if (resolution.autres > 0) {
    ctx.avis(
      `${resolution.autres} autre${resolution.autres > 1 ? "s" : ""} correspondance${resolution.autres > 1 ? "s" : ""} pour « ${ref} ».`,
    );
  }
}
