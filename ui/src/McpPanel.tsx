/*
 * Panneau « MCP » du volet gauche de la page Projets.
 *
 * v1 se contentait de relire `.mcp.json` : il affichait une INTENTION. Ce
 * panneau affiche l'ÉTAT — statut réel de chaque serveur au dernier tour,
 * outils réellement exposés, appels effectués dans la conversation — et donne
 * les leviers qui manquaient :
 *
 *  - interrupteur par serveur (un serveur éteint n'est pas transmis au moteur,
 *    donc ne coûte rien au contexte) ;
 *  - allowlist d'outils (n'exposer que 2 outils d'un serveur qui en a 15) ;
 *  - « Connecter » pour les serveurs distants en attente d'authentification :
 *    le flux OAuth ne peut pas se dérouler dans un tour non interactif, on
 *    ouvre donc un terminal sur le projet avec le geste exact à faire ;
 *  - catalogue de connecteurs (mails IMAP, Airtable, serveur HTTP distant)
 *    qui écrit l'entrée `.mcp.json` et range le jeton dans le coffre local,
 *    au lieu de faire rédiger le JSON à la main.
 *
 * Les préférences (interrupteurs, allowlist) vivent dans
 * `<projet>/.iaction/mcp.local.json` — jamais dans `.mcp.json`, qui est du
 * contrat partagé et versionné.
 */
import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  mcpAdd,
  mcpCatalog,
  mcpRemove,
  mcpSetServer,
  mcpStatus,
  type McpCatalogEntry,
  type McpServerStatus,
  type McpStatus,
} from "./mcpClient";
import { openTerminal } from "./systemClient";

/** Compteurs d'appels par serveur, portés par la conversation active. */
export type McpUsage = Record<string, { calls: number; lastTool: string }>;

/** Statut → libellé court + classe de pastille. Les valeurs viennent du SDK. */
function statusLabel(server: McpServerStatus): { text: string; tone: "ok" | "warn" | "bad" | "off" } {
  if (!server.enabled) return { text: "éteint", tone: "off" };
  if (server.missingSecrets.length > 0) return { text: "secret manquant", tone: "bad" };
  if (server.needsAuth) return { text: "auth requise", tone: "warn" };
  const s = server.status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return { text: "en échec", tone: "bad" };
  if (s === "unknown") return { text: "jamais lancé", tone: "off" };
  if (server.tools.length === 0) return { text: "aucun outil", tone: "warn" };
  return { text: `${server.tools.length} outil${server.tools.length > 1 ? "s" : ""}`, tone: "ok" };
}

function formatCaptured(iso: string | null): string {
  if (!iso) return "jamais observé";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "jamais observé";
  return `constaté ${d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
}

/* ---------- Modale « ajouter un connecteur » ---------- */

function AddConnectorModal({
  cwd,
  onClose,
  onAdded,
}: Readonly<{ cwd: string; onClose: () => void; onAdded: () => void }>) {
  const [entries, setEntries] = useState<McpCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    mcpCatalog()
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        const first = list[0];
        if (first) {
          setSelectedId(first.id);
          setName(first.defaultName);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  function selectEntry(id: string) {
    setSelectedId(id);
    setValues({});
    setError("");
    const entry = entries.find((e) => e.id === id);
    if (entry) setName(entry.defaultName);
  }

  async function submit() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await mcpAdd({ cwd, entryId: selected.id, name: name.trim(), values });
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="Ajouter un serveur MCP" onClose={onClose}>
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>Ajouter un serveur MCP</h3>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="orch-modal__body">
          <div className="field">
            <label htmlFor="mcp-add-kind">Connecteur</label>
            <select id="mcp-add-kind" value={selectedId} onChange={(e) => selectEntry(e.currentTarget.value)}>
              {entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
          {selected && <p className="empty-hint">{selected.description}</p>}
          <div className="field">
            <label htmlFor="mcp-add-name">Nom dans .mcp.json</label>
            <input
              id="mcp-add-name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="imap"
            />
          </div>
          {selected?.fields.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`mcp-add-${field.key}`}>
                {field.label}
                {field.required ? " *" : ""}
              </label>
              <input
                id={`mcp-add-${field.key}`}
                type={field.secret ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.currentTarget.value }))}
              />
            </div>
          ))}
          {selected?.fields.some((f) => f.secret) && (
            <p className="empty-hint">
              Les valeurs marquées comme secrètes ne sont PAS écrites dans le projet : elles vont dans le coffre
              local (fichier 600 hors du dépôt) et .mcp.json ne porte qu'une référence.
            </p>
          )}
          {selected?.note && <p className="empty-hint">{selected.note}</p>}
          {error && <p className="empty-hint empty-hint--error">{error}</p>}
        </div>
        <div className="actions orch-modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="btn" disabled={busy || !selected || !name.trim()} onClick={() => void submit()}>
            {busy ? "Ajout…" : "Ajouter"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Panneau ---------- */

export function McpPanel({
  cwd,
  usage,
  reloadToken,
  onServerCount,
}: Readonly<{
  cwd: string;
  usage: McpUsage;
  /** Bumpé par la page à chaque `init` de tour : l'état constaté vient d'être réécrit. */
  reloadToken: number;
  onServerCount?: (count: number) => void;
}>) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [hint, setHint] = useState("");

  const reload = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    try {
      const next = await mcpStatus(cwd);
      setStatus(next);
      setError("");
    } catch (err) {
      // Sidecar plus ancien ou projet illisible : panneau vide, jamais une
      // erreur bloquante — le reste de la page doit continuer à marcher.
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload, reloadToken]);

  useEffect(() => {
    onServerCount?.(status?.servers.length ?? 0);
  }, [status, onServerCount]);

  async function toggleServer(server: McpServerStatus, enabled: boolean) {
    await mcpSetServer({ cwd, name: server.name, enabled }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    await reload();
  }

  async function toggleTool(server: McpServerStatus, tool: string, allowed: boolean) {
    // `null` (pas d'allowlist) = tous autorisés : décocher un outil fige donc
    // la liste courante moins celui-ci, sinon on perdrait les autres.
    const current = server.allowedTools ?? server.tools;
    const next = allowed ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
    // Tous les outils cochés → on retire l'allowlist plutôt que de figer une
    // liste qui ignorerait un futur outil du serveur.
    const payload = next.length === server.tools.length && server.tools.every((t) => next.includes(t)) ? null : next;
    await mcpSetServer({ cwd, name: server.name, allowedTools: payload }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    await reload();
  }

  /**
   * Un flux OAuth ne peut pas se dérouler dans un tour non interactif : on ne
   * connecte donc rien ici, on ouvre un terminal sur le projet et on donne le
   * geste. Consigne écrite ici plutôt que servie par le sidecar — c'était une
   * méthode de protocole pour une phrase.
   */
  async function connect(server: McpServerStatus) {
    setHint(
      `Dans le terminal qui s'ouvre : lancer \`claude\`, taper \`/mcp\`, puis choisir « ${server.name} » ` +
        "pour dérouler l'authentification. Le jeton obtenu est ensuite réutilisé par les tours d'IAction.",
    );
    try {
      await openTerminal(cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(server: McpServerStatus) {
    await mcpRemove(cwd, server.name).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    await reload();
  }

  const servers = status?.servers ?? [];

  return (
    <div className="mcp-panel">
      {status && (
        <div className="mcp-summary">
          <span>
            {status.mcpToolCount} outil{status.mcpToolCount > 1 ? "s" : ""} MCP
            {status.builtinToolCount > 0 ? ` · ${status.builtinToolCount} intégrés` : ""}
          </span>
          <span className="mcp-summary__when">{formatCaptured(status.capturedAt)}</span>
        </div>
      )}

      {status?.configError && (
        <p className="empty-hint empty-hint--error">.mcp.json illisible : {status.configError}</p>
      )}
      {error && <p className="empty-hint empty-hint--error">{error}</p>}

      {servers.length === 0 ? (
        <p className="empty-hint">
          Aucun serveur MCP. Ajoutez un connecteur ci-dessous, ou déclarez-le dans .mcp.json à la racine du projet.
        </p>
      ) : (
        <ul className="mcp-list">
          {servers.map((server) => {
            const label = statusLabel(server);
            const counters = usage[server.name];
            const open = expanded === server.name;
            const allow = server.allowedTools;
            return (
              <li key={server.name} className={`mcp-item mcp-item--${label.tone}`}>
                <div className="mcp-item__head">
                  <label className="mcp-item__toggle">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(e) => void toggleServer(server, e.currentTarget.checked)}
                      aria-label={`Activer le serveur ${server.name}`}
                    />
                    <span className="mcp-item__name">{server.name}</span>
                  </label>
                  <span className={`mcp-pill mcp-pill--${label.tone}`}>{label.text}</span>
                </div>

                <div className="mcp-item__detail" title={server.detail}>
                  {server.declared ? server.detail : "serveur interne d'IAction"}
                </div>

                {server.missingSecrets.length > 0 && (
                  <div className="mcp-item__warn">
                    Secret absent du coffre : {server.missingSecrets.join(", ")} — serveur non lancé.
                  </div>
                )}

                {counters && (
                  <div className="mcp-item__usage">
                    {counters.calls} appel{counters.calls > 1 ? "s" : ""} dans cette conversation · dernier :{" "}
                    {counters.lastTool}
                  </div>
                )}

                <div className="mcp-item__actions">
                  {server.tools.length > 0 && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--xs"
                      onClick={() => setExpanded(open ? null : server.name)}
                    >
                      {open ? "Masquer les outils" : `Outils (${allow ? `${allow.length}/${server.tools.length}` : server.tools.length})`}
                    </button>
                  )}
                  {server.needsAuth && (
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => void connect(server)}>
                      Connecter
                    </button>
                  )}
                  {server.declared && (
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => void remove(server)}>
                      Retirer
                    </button>
                  )}
                </div>

                {open && (
                  <ul className="mcp-tools">
                    {server.tools.map((tool) => {
                      const checked = allow === null || allow.includes(tool);
                      return (
                        <li key={tool}>
                          <label className="mcp-tools__item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => void toggleTool(server, tool, e.currentTarget.checked)}
                            />
                            <span>{tool}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hint && (
        <p className="mcp-hint">
          {hint}
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => setHint("")}>
            OK
          </button>
        </p>
      )}

      {cwd && (
        <button type="button" className="btn btn--ghost btn--xs mcp-add" onClick={() => setAdding(true)}>
          + Ajouter un connecteur
        </button>
      )}

      {adding && <AddConnectorModal cwd={cwd} onClose={() => setAdding(false)} onAdded={() => void reload()} />}
    </div>
  );
}
