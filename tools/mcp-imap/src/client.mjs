// Connexion IMAP par appel d'outil : connect() puis logout() à chaque
// utilisation (pas de connexion persistante partagée — simple et robuste).
import { ImapFlow } from "imapflow";

/**
 * Ouvre une connexion IMAP, exécute `fn(client)`, referme la connexion (même
 * en cas d'erreur), puis renvoie/relance le résultat de `fn`.
 */
export async function withImapClient(config, fn) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    // Port 143 = cleartext/STARTTLS ; tout le reste (993 par défaut) = TLS direct.
    secure: config.port !== 143,
    auth: { user: config.user, pass: config.password },
    // Le logger par défaut écrirait sur la sortie standard, qui est réservée
    // au protocole MCP (JSON-RPC sur stdout) : on le désactive complètement.
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
