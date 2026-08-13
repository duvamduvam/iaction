/*
 * R9 — Recherche web pour TOUS les modèles (docs/spec-r9-recherche-web.md).
 *
 * ── Pourquoi une capacité locale, et pas le réglage du fournisseur ──────
 * Trois fournisseurs, trois grammaires pour la même intention : suffixe
 * `:online` chez OpenRouter, un AUTRE modèle (`perplexityonline`) chez
 * Swiftask, les outils du SDK chez Claude. Les suivre, c'est un `if` par
 * marque — la plomberie que T-023 cherche à supprimer. Une recherche que
 * l'application possède les rend tous inutiles, et vaudra pour les
 * fournisseurs qui n'existent pas encore.
 *
 * ── Pourquoi l'injection, et pas un outil ──────────────────────────────
 * `chat.send` n'a AUCUNE boucle d'appels d'outils, et l'appel de fonction
 * n'est pas universel (Swiftask oui, Ollama selon le modèle). L'injection
 * couvre 100 % des modèles sans toucher au moteur. Le prix : une seule passe,
 * le modèle ne peut pas raffiner sa requête. C'est le compromis assumé de la
 * spec, §Objectif.
 *
 * ── Ce que ce module ne fait pas ───────────────────────────────────────
 * Il ne connaît ni fournisseur, ni conversation, ni protocole : il reçoit une
 * question, il rend un bloc de texte et une liste de sources. C'est `engine.ts`
 * qui décide de l'injecter. Les fonctions pures (extraction, troncature,
 * construction du bloc, garde d'URL) sont exportées et testées sans réseau.
 */
import { lookup } from "node:dns/promises";

import { errMessage, isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";

// ---------------------------------------------------------------------------
// Contrat
// ---------------------------------------------------------------------------

export interface ResultatWeb {
  titre: string;
  url: string;
  extrait: string;
  date?: string;
}

/** Source citable, telle qu'elle part vers l'interface (jamais le texte extrait). */
export interface SourceWeb {
  n: number;
  titre: string;
  url: string;
}

export type EtatWeb = "ok" | "vide" | "echec";

export interface ContexteWeb {
  etat: EtatWeb;
  sources: SourceWeb[];
  /** Bloc à injecter en tête des messages du tour. Jamais vide : voir §4 de la spec. */
  bloc: string;
  message?: string;
}

/**
 * Le moteur est derrière une interface pour que passer à Brave ou Tavily soit
 * une implémentation de plus, pas une refonte. SearXNG est la seule fournie :
 * c'est un MÉTA-moteur (des dizaines de sources en dessous), sans clé, sans
 * facture, sans quota, en local — la doctrine du projet appliquée telle quelle.
 */
export interface MoteurRecherche {
  rechercher(question: string, nombre: number): Promise<ResultatWeb[]>;
}

// ---------------------------------------------------------------------------
// Bornes — chacune est là parce que sans elle un cas réel casse le tour
// ---------------------------------------------------------------------------

/** Résultats demandés au moteur. */
export const NB_RESULTATS = 5;
/** Résultats dont on va VRAIMENT chercher la page (les autres n'ont que leur extrait). */
export const NB_PAGES = 3;
/** Texte retenu par page. Au-delà, on tronque : on prépare un contexte, pas une archive. */
export const MAX_TEXTE_PAGE = 10 * 1024;
/** Budget total injecté, tous extraits confondus. */
export const BUDGET_INJECTE = 4 * 1024;
const DELAI_RECHERCHE_MS = 5000;
const DELAI_PAGE_MS = 3000;

export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8081";

// ---------------------------------------------------------------------------
// Configuration — poussée par `router.set`, lue par `engine.ts`
// ---------------------------------------------------------------------------

/*
 * Elle vit ICI et pas dans router.ts : `router.ts` importe déjà `engine.ts`,
 * et `engine.ts` doit lire cette config pendant le tour. La loger dans le
 * routeur créerait le cycle engine ↔ router. Ce module ne dépend que du socle,
 * tout le monde peut donc en dépendre sans refermer le graphe.
 */
export interface WebSearchConfig {
  baseUrl: string;
}

export const DEFAULT_WEB_SEARCH: WebSearchConfig = { baseUrl: DEFAULT_SEARXNG_URL };

let configCourante: WebSearchConfig = { ...DEFAULT_WEB_SEARCH };

/** Retrait des `/` finaux sans expression régulière : `/\/+$/` backtracke sur une entrée hostile. */
function sansSlashFinal(valeur: string): string {
  let out = valeur;
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Validation souple, comme les autres champs de `router.set` : invalide → défaut, jamais d'erreur. */
export function setWebSearchConfig(brut: unknown): void {
  const baseUrl = isPlainObject(brut) ? brut.baseUrl : undefined;
  configCourante = isNonEmptyString(baseUrl) && /^https?:\/\//i.test(baseUrl)
    ? { baseUrl: sansSlashFinal(baseUrl) }
    : { ...DEFAULT_WEB_SEARCH };
}

export function getWebSearchConfig(): WebSearchConfig {
  return { ...configCourante };
}

// ---------------------------------------------------------------------------
// Garde d'URL — appliquée aux pages de RÉSULTAT, jamais au moteur lui-même
// ---------------------------------------------------------------------------

/*
 * Le moteur, lui, est légitimement local (127.0.0.1:8081) : c'est l'utilisateur
 * qui l'a déclaré. Ce qui est dangereux, c'est de suivre une URL arbitraire
 * TROUVÉE dans des résultats — elle pourrait viser le réseau privé du poste.
 */

/** Vrai si l'adresse littérale appartient à une plage locale/privée. */
export function adresseInterdite(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) {
    return true;
  }
  // IPv4 mappée en IPv6 (::ffff:127.0.0.1) : on retombe sur le test v4.
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v)?.[1] ?? v;
  const octets = v4.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) {
    return false;
  }
  const [a, b] = octets.map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // lien-local, dont les métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export type VerdictUrl = { ok: true; url: URL } | { ok: false; raison: string };

/**
 * Contrôle SYNCHRONE, avant tout accès réseau : schéma, puis hôte quand il est
 * une adresse littérale ou un nom local évident. La résolution DNS (cas d'un
 * nom public qui pointe vers une adresse privée) est faite juste après par
 * `hoteAutorise` — séparée pour rester testable sans réseau.
 */
export function urlAutorisee(brut: string): VerdictUrl {
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return { ok: false, raison: "URL illisible" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, raison: `schéma refusé : ${url.protocol}` };
  }
  const hote = url.hostname.toLowerCase();
  if (hote === "localhost" || hote.endsWith(".localhost") || hote.endsWith(".local")) {
    return { ok: false, raison: "hôte local" };
  }
  if (adresseInterdite(hote)) {
    return { ok: false, raison: "adresse privée ou locale" };
  }
  return { ok: true, url };
}

/** Second filet : le nom résout-il vers une adresse publique ? */
async function hoteAutorise(url: URL): Promise<boolean> {
  try {
    const { address } = await lookup(url.hostname);
    return !adresseInterdite(address);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extraction de texte — à la main, zéro dépendance nouvelle
// ---------------------------------------------------------------------------

const ENTITES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ecirc: "ê",
  rsquo: "’",
  hellip: "…",
};

/**
 * Réduit un document HTML à son texte. Grossier et assumé : on prépare un
 * contexte pour un modèle, on ne rend pas une page. `<script>` et `<style>`
 * partent AVEC leur contenu — sinon on injecterait du JavaScript, qui coûte du
 * contexte et n'apprend rien.
 */
export function extraireTexte(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  // Une passe par balise, sans référence arrière : un motif à backreference sur
  // un document de plusieurs centaines de kilo-octets part en backtracking.
  for (const balise of ["script", "style", "noscript", "svg"]) {
    out = out.replace(new RegExp(`<${balise}\\b[^>]*>[\\s\\S]*?</${balise}>`, "gi"), " ");
  }
  return out
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d{1,7});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]{2,10});/gi, (entier, nom: string) => ENTITES[nom.toLowerCase()] ?? entier)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Tronque sur une frontière de mot quand c'est possible, et le DIT. */
export function tronquer(texte: string, max: number): string {
  if (texte.length <= max) {
    return texte;
  }
  const coupe = texte.slice(0, max);
  const dernierEspace = coupe.lastIndexOf(" ");
  const garde = dernierEspace > max * 0.8 ? coupe.slice(0, dernierEspace) : coupe;
  return `${garde}\n[…tronqué]`;
}

// ---------------------------------------------------------------------------
// Bloc injecté
// ---------------------------------------------------------------------------

export interface EntreeBloc {
  titre: string;
  url: string;
  date?: string;
  texte: string;
}

const CONSIGNE =
  "Cite tes sources par leur numéro, sous la forme [1]. N'invente aucune source. " +
  "Si ces extraits ne suffisent pas, dis-le au lieu de compléter de mémoire.";

/** Bloc des résultats. `dateISO` est passée (jamais lue de l'horloge ici) pour rester testable. */
export function construireBloc(entrees: EntreeBloc[], dateISO: string): string {
  const corps = entrees
    .map((e, i) => {
      const date = e.date ? ` (${e.date})` : "";
      return `[${i + 1}] ${e.titre} — ${e.url}${date}\n${e.texte}`;
    })
    .join("\n\n");
  return `Résultats de recherche web du ${dateISO}, pour répondre à la question ci-dessous.\n${CONSIGNE}\n\n${corps}`;
}

/*
 * Les deux blocs d'honnêteté. Ils existent pour que l'échec de la recherche ne
 * se transforme JAMAIS en réponse de mémoire présentée comme fraîche — c'est
 * le défaut fondateur de T-010, et il ne doit pas être remplacé par un silence
 * d'un autre genre.
 */
export const BLOC_VIDE =
  "La recherche web n'a renvoyé aucun résultat. Réponds sans prétendre avoir consulté le web, " +
  "et dis clairement que tu n'as pas pu vérifier l'information.";

export function blocEchec(message: string): string {
  return (
    `La recherche web a échoué (${message}). Dis-le explicitement dans ta réponse, ` +
    "et ne présente aucune information comme récente ou vérifiée."
  );
}

// ---------------------------------------------------------------------------
// Moteur SearXNG
// ---------------------------------------------------------------------------

function normaliserResultat(brut: unknown): ResultatWeb | null {
  if (!isPlainObject(brut)) return null;
  const url = brut.url;
  const titre = brut.title;
  if (!isNonEmptyString(url) || !isNonEmptyString(titre)) return null;
  return {
    titre,
    url,
    extrait: isNonEmptyString(brut.content) ? brut.content : "",
    ...(isNonEmptyString(brut.publishedDate) ? { date: brut.publishedDate.slice(0, 10) } : {}),
  };
}

export function creerMoteurSearxng(baseUrl: string): MoteurRecherche {
  const racine = sansSlashFinal(baseUrl);
  return {
    async rechercher(question, nombre) {
      const url = `${racine}/search?q=${encodeURIComponent(question)}&format=json&language=fr`;
      const res = await fetch(url, { signal: AbortSignal.timeout(DELAI_RECHERCHE_MS) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as unknown;
      const bruts = isPlainObject(json) && Array.isArray(json.results) ? json.results : [];
      const resultats: ResultatWeb[] = [];
      for (const b of bruts) {
        const r = normaliserResultat(b);
        if (r) resultats.push(r);
        if (resultats.length >= nombre) break;
      }
      return resultats;
    },
  };
}

// ---------------------------------------------------------------------------
// Récupération d'une page
// ---------------------------------------------------------------------------

/** Renvoie le texte de la page, ou `null` — une page qui échoue est SAUTÉE, jamais fatale. */
export async function recupererPage(brut: string): Promise<string | null> {
  const verdict = urlAutorisee(brut);
  if (!verdict.ok) {
    journal.debug("neutral", "page web écartée", { fields: { url: brut, raison: verdict.raison } });
    return null;
  }
  if (!(await hoteAutorise(verdict.url))) {
    journal.debug("neutral", "page web écartée", { fields: { url: brut, raison: "résolution privée" } });
    return null;
  }
  try {
    const res = await fetch(verdict.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DELAI_PAGE_MS),
      headers: { Accept: "text/html,text/plain" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html") && !type.includes("text/plain")) return null;
    // Lecture bornée : on s'arrête dès qu'on a de quoi remplir un extrait,
    // sans attendre la fin d'une page de plusieurs mégaoctets.
    const brutHtml = await lireBorne(res, MAX_TEXTE_PAGE * 4);
    const texte = extraireTexte(brutHtml);
    return texte.length > 0 ? tronquer(texte, MAX_TEXTE_PAGE) : null;
  } catch {
    return null;
  }
}

async function lireBorne(res: Response, maxOctets: number): Promise<string> {
  if (!res.body) return "";
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder();
  let sortie = "";
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    sortie += decodeur.decode(value, { stream: true });
    if (total >= maxOctets) {
      await lecteur.cancel().catch(() => undefined);
      break;
    }
  }
  return sortie;
}

// ---------------------------------------------------------------------------
// Classement des extraits
// ---------------------------------------------------------------------------

/**
 * R9 — classe des textes ARBITRAIRES (pages web récupérées) contre une
 * question, et rend au plus `budget` caractères par source, les plus proches
 * d'abord. Même pipeline que la recherche ci-dessus — découpe, embeddings,
 * cosinus — mais sans index sur disque : la source est passée en mémoire.
 *
 * Vit ici, et non dans `knowledge.ts`, parce que c'est une POLITIQUE de
 * recherche web (budget par source, repli) et non une primitive
 * d'embeddings — `knowledge.ts` n'expose que `embedTexts`/`rankChunks`.
 *
 * Renvoie `null` — jamais une exception — si les embeddings sont
 * indisponibles : l'appelant se rabat alors sur les extraits du moteur.
 */
export async function classerExtraits(
  query: string,
  entrees: { source: string; texte: string }[],
  budget: number,
): Promise<Map<string, string> | null> {
  // Import dynamique : `knowledge.js` remonte jusqu'à `engine.js`, qui
  // importe CE module. En statique, le graphe se refermerait.
  const { chunkText, embedTexts, rankChunks } = await import("./knowledge.js");

  const chunks: Array<{ file: string; text: string }> = [];
  for (const entree of entrees) {
    for (const text of chunkText(entree.texte)) {
      chunks.push({ file: entree.source, text });
    }
  }
  if (chunks.length === 0) {
    return null;
  }

  // La requête voyage dans le MÊME lot que les chunks : un aller-retour au lieu
  // de deux, et la garantie que tout est plongé par le même modèle.
  const embedded = await embedTexts([...chunks.map((c) => c.text), query]);
  if (!embedded.ok) {
    journal.warn("neutral", "classement web sans embeddings", { fields: { message: embedded.message } });
    return null;
  }
  const queryEmbedding = embedded.embeddings.at(-1) as number[];
  const avecEmbedding = chunks.map((c, i) => ({ ...c, embedding: embedded.embeddings[i] }));
  const classes = rankChunks(queryEmbedding, avecEmbedding, chunks.length);

  // Budget PAR SOURCE : sans ça, une page bavarde monopolise l'injection et
  // les autres sources n'apparaissent que par leur titre.
  const parSource = Math.max(1, Math.floor(budget / Math.max(1, entrees.length)));
  const retenu = new Map<string, string[]>();
  const tailles = new Map<string, number>();
  for (const r of classes) {
    const dejaPris = tailles.get(r.file) ?? 0;
    if (dejaPris >= parSource) continue;
    const morceau = r.excerpt.slice(0, parSource - dejaPris);
    retenu.set(r.file, [...(retenu.get(r.file) ?? []), morceau]);
    tailles.set(r.file, dejaPris + morceau.length);
  }
  return new Map([...retenu].map(([source, morceaux]) => [source, morceaux.join("\n…\n")]));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DepsContexteWeb {
  moteur: MoteurRecherche;
  /** Injectable pour les tests ; par défaut la vraie récupération HTTP. */
  recuperer?: (url: string) => Promise<string | null>;
  /** Classement par embeddings (knowledge.ts). Absent ou en échec → repli sur les extraits. */
  classer?: (
    requete: string,
    entrees: { source: string; texte: string }[],
    budget: number,
  ) => Promise<Map<string, string> | null>;
  dateISO: string;
}

/**
 * Prépare le contexte web d'un tour. Ne LÈVE jamais : toute panne devient un
 * `etat` et un bloc d'honnêteté — l'appelant injecte toujours quelque chose.
 */
export async function preparerContexteWeb(question: string, deps: DepsContexteWeb): Promise<ContexteWeb> {
  let resultats: ResultatWeb[];
  try {
    resultats = await deps.moteur.rechercher(question, NB_RESULTATS);
  } catch (err) {
    const message = errMessage(err);
    signalerEchecUneFois(message);
    return { etat: "echec", sources: [], bloc: blocEchec(message), message };
  }

  if (resultats.length === 0) {
    return { etat: "vide", sources: [], bloc: BLOC_VIDE };
  }

  const recuperer = deps.recuperer ?? recupererPage;
  const pages = await Promise.all(
    resultats.slice(0, NB_PAGES).map(async (r) => ({ url: r.url, texte: await recuperer(r.url) })),
  );
  const texteParUrl = new Map(pages.filter((p) => p.texte).map((p) => [p.url, p.texte as string]));

  // Classement : on injecte les ~4 Ko les plus proches de la question, pas les
  // 30 Ko bruts. Repli explicite sur les extraits du moteur si les embeddings
  // sont indisponibles (Ollama arrêté est une panne connue) — dégradé, pas mort.
  let retenu: Map<string, string> | null = null;
  if (deps.classer && texteParUrl.size > 0) {
    const entrees = [...texteParUrl].map(([source, texte]) => ({ source, texte }));
    retenu = await deps.classer(question, entrees, BUDGET_INJECTE).catch(() => null);
  }

  const entrees: EntreeBloc[] = resultats.map((r) => ({
    titre: r.titre,
    url: r.url,
    ...(r.date ? { date: r.date } : {}),
    texte: retenu?.get(r.url) ?? texteParUrl.get(r.url) ?? r.extrait,
  }));

  const sources: SourceWeb[] = resultats.map((r, i) => ({ n: i + 1, titre: r.titre, url: r.url }));
  return { etat: "ok", sources, bloc: construireBloc(entrees, deps.dateISO) };
}

/*
 * Une fois par processus, pas par tour : l'absence de recherche doit être un
 * fait visible dans le journal, sans pour autant l'inonder quand le conteneur
 * est arrêté pour la soirée.
 */
let echecSignale = false;

function signalerEchecUneFois(message: string): void {
  if (echecSignale) return;
  echecSignale = true;
  journal.warn("neutral", "recherche web indisponible", { fields: { message } });
}

/** Tests seulement : remet le témoin « déjà signalé » à zéro. */
export function reinitialiserSignalement(): void {
  echecSignale = false;
}

// ---------------------------------------------------------------------------
// Branchement sur un tour de chat
// ---------------------------------------------------------------------------

/*
 * Ces deux fonctions vivaient dans engine.ts, où le cliquet de taille les a
 * refusées — à raison : ce n'est pas de la mécanique de flux SSE, c'est de la
 * recherche web. `EngineEmitter` est importé en TYPE seulement (effacé à la
 * compilation) : aucun cycle de modules, même règle que providerFormCalc.ts côté
 * interface.
 */

/** Repérage du dernier message utilisateur — dupliqué d'engine.ts, 4 lignes, pas d'import de valeur. */
function indexDernierUtilisateur(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isPlainObject(m) && m.role === "user") return i;
  }
  return -1;
}

/**
 * R9 — texte de la question à envoyer au moteur : le dernier message
 * utilisateur, tel quel. Pas de reformulation par un LLM (hors périmètre de la
 * spec) : ce serait un appel de plus, une latence de plus et une source de
 * bugs de plus, pour un gain non démontré.
 */
function questionPourRecherche(messages: unknown[]): string {
  const idx = indexDernierUtilisateur(messages);
  const m = idx === -1 ? null : messages[idx];
  const content = isPlainObject(m) ? m.content : null;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * R9 — cherche, puis préfixe le bloc de résultats aux messages du SEUL tour en
 * cours. Le bloc n'est jamais persisté : des résultats d'hier ne doivent pas
 * polluer la question de demain, ni faire enfler la jauge de contexte tour
 * après tour.
 *
 * Ne lève jamais : une recherche en panne produit un bloc qui ORDONNE au
 * modèle de le dire, jamais un tour perdu ni une réponse de mémoire présentée
 * comme fraîche (T-010).
 */
export async function injecterContexteWeb(
  id: string,
  messages: unknown[],
  sendMessages: unknown[],
  emitter: EngineEmitter,
): Promise<unknown[]> {
  const question = questionPourRecherche(messages);
  if (question.length === 0) {
    return sendMessages;
  }
  emitter.chunk(id, { web: { etat: "recherche" } });

  const contexte = await preparerContexteWeb(question, {
    moteur: creerMoteurSearxng(getWebSearchConfig().baseUrl),
    classer: classerExtraits,
    dateISO: new Date().toISOString().slice(0, 10),
  });

  emitter.chunk(id, {
    web: {
      etat: contexte.etat,
      sources: contexte.sources,
      ...(contexte.message ? { message: contexte.message } : {}),
    },
  });

  return [{ role: "system", content: contexte.bloc }, ...sendMessages];
}
