/**
 * Client HTTP du relais entre studios — bibliothèque standard seulement (le
 * serveur relais tourne seul, lancé par le node embarqué).
 *
 * Pourquoi pas `fetch` : celui de Node 22 ignore `HTTPS_PROXY`, or un poste
 * d'entreprise sort souvent par un proxy. Le réglage proxy SYSTÈME de
 * Windows (et les scripts PAC) n'est pas lu : le connecteur a un champ
 * « Proxy HTTPS » qui pose `HTTPS_PROXY` pour ce seul serveur. Ici, un proxy déclaré dans
 * l'environnement (`HTTPS_PROXY`/`https_proxy`, hors `NO_PROXY`) est suivi
 * par un tunnel `CONNECT`, et une autorité de certification supplémentaire
 * (proxy qui réécrit le TLS) s'ajoute aux racines du système.
 *
 * `http://` n'est accepté que vers la boucle locale (tests, broker local) :
 * le jeton ne circule jamais en clair sur un réseau.
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export interface RequeteRelais {
  methode: "GET" | "POST" | "DELETE";
  url: URL;
  entetes?: Record<string, string>;
  corps?: Buffer;
  /** Autorité de certification supplémentaire (PEM). */
  ca?: string;
  /** Environnement pour le proxy (injectable en test). */
  env?: NodeJS.ProcessEnv;
}

export interface ReponseRelais {
  statut: number;
  corps: Buffer;
}

const DELAI_MS = 120_000;
const BOUCLE = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** L'adresse est-elle acceptable ? Message d'erreur, ou `null`. */
export function controlerAdresse(url: URL): string | null {
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && BOUCLE.has(url.hostname)) return null;
  return "adresse du relais refusée : https:// exigé (http:// seulement vers la boucle locale)";
}

/** Proxy à utiliser pour `cible`, ou `null`. */
export function proxyPour(cible: URL, env: NodeJS.ProcessEnv = process.env): URL | null {
  if (BOUCLE.has(cible.hostname)) return null;
  const brut = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!brut) return null;
  const exclus = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hote = cible.hostname.toLowerCase();
  if (exclus.some((e) => e === "*" || hote === e.replace(/^\./, "") || hote.endsWith(e.startsWith(".") ? e : `.${e}`))) {
    return null;
  }
  try {
    return new URL(brut.includes("://") ? brut : `http://${brut}`);
  } catch {
    return null;
  }
}

function tunnel(proxy: URL, cible: URL): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const entetes: Record<string, string> = { Host: `${cible.hostname}:${cible.port || 443}` };
    if (proxy.username) {
      const ident = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      entetes["Proxy-Authorization"] = `Basic ${Buffer.from(ident).toString("base64")}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${cible.hostname}:${cible.port || 443}`,
      headers: entetes,
      timeout: DELAI_MS,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`le proxy refuse le tunnel (HTTP ${res.statusCode})`));
      }
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé en joignant le proxy")));
    req.on("error", reject);
    req.end();
  });
}

/** Exécute une requête ; rejette sur une erreur réseau (jamais sur un statut). */
export async function requeteRelais(r: RequeteRelais): Promise<ReponseRelais> {
  const refus = controlerAdresse(r.url);
  if (refus) throw new Error(refus);
  const https_ = r.url.protocol === "https:";
  const ca = r.ca ? [...tls.rootCertificates, r.ca] : undefined;
  const proxy = https_ ? proxyPour(r.url, r.env) : null;
  const socket = proxy ? await tunnel(proxy, r.url) : null;
  const entetes: Record<string, string | number> = { ...(r.entetes ?? {}) };
  if (r.corps) entetes["Content-Length"] = r.corps.length;
  const options: https.RequestOptions = {
    method: r.methode,
    hostname: r.url.hostname,
    port: r.url.port || (https_ ? 443 : 80),
    path: `${r.url.pathname}${r.url.search}`,
    headers: entetes,
    timeout: DELAI_MS,
    ...(ca ? { ca } : {}),
    ...(socket
      ? // Pas de `agent: false` : avec lui, Node crée un agent neuf qui IGNORE
        // `createConnection` ; la requête partait hors du tunnel et rien ne
        // passait (relecture adverse, I2). La vérification TLS reste entière.
        { createConnection: () => tls.connect({ socket, servername: r.url.hostname, ...(ca ? { ca } : {}) }) }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (https_ ? https : http).request(options, (res) => {
      const morceaux: Buffer[] = [];
      res.on("data", (m: Buffer) => morceaux.push(m));
      res.on("end", () => resolve({ statut: res.statusCode ?? 0, corps: Buffer.concat(morceaux) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé en joignant le relais")));
    req.on("error", reject);
    if (r.corps) req.write(r.corps);
    req.end();
  });
}

/** Corps `multipart/form-data` d'un seul fichier, champ `file`. */
export function corpsMultipart(nomFichier: string, contenu: Buffer): { corps: Buffer; type: string } {
  const frontiere = `----iaction-relais-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const nomSur = nomFichier.replace(/["\r\n\\]/g, "_");
  const tete = Buffer.from(
    `--${frontiere}\r\nContent-Disposition: form-data; name="file"; filename="${nomSur}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const pied = Buffer.from(`\r\n--${frontiere}--\r\n`);
  return { corps: Buffer.concat([tete, contenu, pied]), type: `multipart/form-data; boundary=${frontiere}` };
}
