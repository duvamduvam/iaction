/*
 * T-118 — situer une erreur du moteur Claude au lieu de la répéter brute.
 *
 * Constat du 2026-09-02, poste Windows : « API Error: Unable to connect to
 * API (ConnectionRefused) », affiché tel quel, en rafale toutes les 10 min.
 * L'utilisateur en a conclu « l'application ne marche pas » — la seule
 * conclusion qu'un message d'API brut autorise. Le diagnostic à distance a
 * montré que ni l'app, ni un certificat, ni un proxy n'étaient en cause :
 * c'était un incident réseau transitoire. Mais RIEN dans l'affichage ne
 * permettait de le soupçonner, et c'est cela qui nous appartient.
 *
 * Trois familles portent trois gestes DIFFÉRENTS, et les confondre envoie
 * déboguer le mauvais problème :
 * - abonnement saturé  → attendre la réinitialisation (jauge d'en-tête) ;
 * - HTTPS intercepté   → antivirus/proxy qui inspecte le TLS (piste T-085) ;
 * - API injoignable    → réseau, VPN, pare-feu ;
 * - CLI non connecté   → `claude login` ou clé API.
 *
 * Module à part, PUR : classer un message n'a besoin ni du SDK ni du disque.
 * Extrait de `claude.ts` (où il vivait sous le nom `decorateAuthError`) le
 * 2026-09-19, pour que la liste des familles se lise d'un coup d'œil et que
 * chacune soit testable isolément.
 */

/** Famille de cause, déduite du seul texte du message. */
export type FamilleErreurClaude = "abonnement" | "tls" | "reseau" | "authentification" | "inconnue";

/** Abonnement saturé — le mot « limit » côtoie souvent « credit »/« plan ». */
const RE_ABONNEMENT = /usage limit|rate.?limit|limit reached|quota/i;

/**
 * HTTPS intercepté. Doit primer sur le réseau : le message complet observé en
 * août était « Unable to connect to API: SSL certificate hostname mismatch »,
 * qui appartient aux DEUX vocabulaires — et le geste utile est celui du TLS.
 */
const RE_TLS = /certificate|ssl|self.signed|ERR_TLS|hostname mismatch|unable to verify/i;

/**
 * API injoignable. Couvre le message du CLI (« Unable to connect to API »),
 * ses suffixes observés (`ConnectionRefused`), les codes de Node et ceux
 * d'undici, que le CLI et le sidecar produisent selon la pile qui échoue.
 */
const RE_RESEAU =
  /unable to connect|connection ?refused|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|fetch failed|socket hang up|network error/i;

/** CLI non connecté / clé absente. */
const RE_AUTH = /auth|login|api key|unauthorized|401/i;

/**
 * Classe un message d'erreur du moteur Claude.
 *
 * L'ORDRE est significatif et c'est tout l'objet de cette fonction : un même
 * message porte souvent le vocabulaire de plusieurs familles, et la première
 * qui matche gagne. Abonnement d'abord (T-059 : conseiller « claude login » à
 * un compte à quota épuisé l'envoie déboguer le mauvais problème), puis TLS
 * avant réseau (un certificat refusé EST une connexion qui échoue, mais le
 * geste n'est pas le même), puis réseau avant authentification (« Unable to
 * connect to API » ne dit rien d'un défaut d'identifiants).
 */
export function classerErreurClaude(message: string): FamilleErreurClaude {
  if (RE_ABONNEMENT.test(message)) return "abonnement";
  if (RE_TLS.test(message)) return "tls";
  if (RE_RESEAU.test(message)) return "reseau";
  if (RE_AUTH.test(message)) return "authentification";
  return "inconnue";
}

/** Conseil attaché à chaque famille — un geste par famille, jamais deux. */
const CONSEILS: Readonly<Record<Exclude<FamilleErreurClaude, "inconnue">, string>> = {
  abonnement:
    "limite d'abonnement atteinte ; voir la jauge de session en en-tête pour le temps restant avant réinitialisation.",
  tls:
    "la connexion HTTPS vers l'API est interceptée : un antivirus qui inspecte le HTTPS, un proxy d'entreprise ou un portail captif présente son propre certificat. L'application et vos identifiants ne sont pas en cause.",
  reseau:
    "l'API Claude est injoignable depuis ce poste : réseau, VPN ou pare-feu. Vos identifiants ne sont pas en cause. Vérifiez l'accès réseau (VPN reconnecté ? portail à valider ?) puis réessayez.",
  authentification:
    "connectez-vous via `claude login` ou configurez une clé API dans Fournisseurs.",
};

/**
 * Message brut suivi du geste qui correspond à sa famille. Un message qu'on
 * ne sait pas classer est rendu TEL QUEL : mieux vaut pas de conseil qu'un
 * conseil faux (T-103 — « un conseil faux est pire qu'un conseil absent, il
 * fait conclure que le problème est ailleurs »).
 */
export function decorerErreurClaude(message: string): string {
  const famille = classerErreurClaude(message);
  if (famille === "inconnue") return message;
  return `${message} — ${CONSEILS[famille]}`;
}
