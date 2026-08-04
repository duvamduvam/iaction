// Résolution de la configuration IMAP depuis les variables d'environnement.
//
// Le mot de passe est résolu UNE SEULE FOIS, au démarrage du serveur (jamais
// re-résolu par appel d'outil, jamais loggé, jamais écrit sur disque).
//
// Deux façons d'échouer, volontairement différentes :
// - Configuration absente/incomplète (IMAP_HOST/IMAP_USER/mot de passe non
//   fournis) : le serveur démarre quand même (handshake MCP + tools/list
//   fonctionnent), et chaque appel d'outil renvoie une erreur d'outil propre
//   (isError) expliquant ce qui manque — jamais de crash.
// - Un `IMAP_PASSWORD_KEYRING` est fourni mais le lookup `secret-tool`
//   échoue réellement (secret absent, trousseau verrouillé, binaire manquant...) :
//   c'est un vrai problème système signalé explicitement par l'utilisateur,
//   donc on échoue fort dès le démarrage (message clair sur stderr, exit 1).
import { spawnSync } from "node:child_process";

function parseKeyringSpec(spec) {
  // Format attendu : "service=iaction account=imap-david-duvam"
  const parts = {};
  for (const token of spec.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    parts[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return parts;
}

function lookupKeyringOrExit(spec) {
  const { service, account } = parseKeyringSpec(spec);
  if (!service || !account) {
    hardFail(
      `IMAP_PASSWORD_KEYRING mal formé : "${spec}" ` +
        '(attendu "service=<s> account=<a>").',
    );
  }
  const result = spawnSync(
    "secret-tool",
    ["lookup", "service", service, "account", account],
    { encoding: "utf8" },
  );
  if (result.error) {
    hardFail(
      `échec du lancement de secret-tool (${result.error.message}) — ` +
        "le paquet libsecret-tools est-il installé ?",
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    hardFail(
      `secret-tool lookup a échoué (service=${service} account=${account})` +
        `${stderr ? " : " + stderr : ""}. Vérifiez que le secret existe ` +
        "dans le trousseau (secret-tool store --label=... service <s> account <a>).",
    );
  }
  const password = (result.stdout || "").trim();
  if (!password) {
    hardFail(
      `secret-tool a renvoyé un mot de passe vide (service=${service} account=${account}).`,
    );
  }
  return password;
}

function hardFail(message) {
  process.stderr.write(`[mcp-imap] Erreur de configuration : ${message}\n`);
  process.exit(1);
}

/**
 * Lit la configuration IMAP depuis l'environnement.
 *
 * Renvoie soit `{ ok: true, host, port, user, password, readOnly }`, soit
 * `{ ok: false, error }` si la configuration est absente/incomplète (cas non
 * fatal). N'appelle `process.exit` QUE si un `IMAP_PASSWORD_KEYRING` explicite
 * a été fourni mais que son lookup échoue réellement.
 */
export function resolveImapConfig(env = process.env) {
  const readOnly = env.MCP_IMAP_READONLY === "1";
  const host = env.IMAP_HOST;
  const user = env.IMAP_USER;

  const missing = [];
  if (!host) missing.push("IMAP_HOST");
  if (!user) missing.push("IMAP_USER");
  if (!env.IMAP_PASSWORD && !env.IMAP_PASSWORD_KEYRING) {
    missing.push("IMAP_PASSWORD ou IMAP_PASSWORD_KEYRING");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `configuration IMAP incomplète — variable(s) manquante(s) : ${missing.join(", ")}.`,
    };
  }

  let port = 993;
  if (env.IMAP_PORT) {
    const parsed = Number(env.IMAP_PORT);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: `IMAP_PORT invalide : "${env.IMAP_PORT}".` };
    }
    port = parsed;
  }

  const password = env.IMAP_PASSWORD || lookupKeyringOrExit(env.IMAP_PASSWORD_KEYRING);

  return { ok: true, host, port, user, password, readOnly };
}
