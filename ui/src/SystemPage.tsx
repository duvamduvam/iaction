/*
 * Page « Système » : en tête, le panneau « Journal » — les erreurs de
 * l'application par criticité, lues dans le journal persistant du sidecar
 * (voir docs/protocol.md § « Méthodes L1 — journal applicatif (logs) » et
 * docs/etude-logs.md § 2.6). En dessous, les panneaux de debug hérités du
 * Lot 0 (ping, stream d'écho brut) et le flux brut « Logs sidecar », replié :
 * utile au debug vif, ce n'est plus la vue principale.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { request, subscribeLog } from "./sidecar";
import {
  emptyCounts,
  estJournalIndisponible,
  logPurge,
  logRead,
  LOG_LEVELS,
  LOG_SCOPES,
  type LogCounts,
  type LogEntry,
  type LogLevel,
  type LogScope,
} from "./logsClient";
import { Markdown } from "./Markdown";
import {
  estBacklogIndisponible,
  ticketsList,
  trierTickets,
  TICKET_PRIOS,
  TICKET_TYPES,
  type Ticket,
  type TicketPrio,
  type TicketStatut,
} from "./ticketsClient";
import { tachesReportRead, tachesReports, type TacheReportInfo } from "./tachesClient";
import { useRovingFocus } from "./useRovingFocus";

const MAX_LOG_LINES = 200;

const DEFAULT_STREAM_TEXT =
  "Bienvenue dans IAction. Ce texte est renvoyé mot à mot par le sidecar, " +
  "comme le ferait un modèle de langage en train de générer sa réponse.";

/* ---------- Panneau Ping ---------- */

type PingState = "idle" | "pending" | "error";

function PingPanel() {
  const [state, setState] = useState<PingState>("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  async function handlePing() {
    setState("pending");
    setErrorMessage("");
    const startedAt = Date.now();
    try {
      const { done } = request("ping", {});
      await done;
      setLatencyMs(Date.now() - startedAt);
      setState("idle");
    } catch (err) {
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  let resultClass = "result-line";
  let resultText = "Aucun ping envoyé pour l'instant.";
  if (state === "error") {
    resultClass += " result-line--error";
    resultText = `Erreur : ${errorMessage}`;
  } else if (latencyMs !== null) {
    resultClass += " result-line--ok";
    resultText = `Pong reçu en ${latencyMs} ms`;
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Ping</h2>
      <p className="empty-hint">
        Envoie une requête <code>ping</code> minimale et mesure le temps jusqu'au <code>done</code>.
      </p>
      <div className="actions">
        <button className="btn" onClick={handlePing} disabled={state === "pending"}>
          {state === "pending" ? "Envoi…" : "Envoyer un ping"}
        </button>
      </div>
      <div className={resultClass}>{resultText}</div>
    </section>
  );
}

/* ---------- Panneau Stream ---------- */

type StreamStatus = "streaming" | "done" | "error";

interface StreamEntry {
  id: string;
  text: string;
  status: StreamStatus;
  errorMessage?: string;
}

// Helpers purs (hors du composant) pour garder les callbacks peu imbriqués.
function withAppendedChunk(entries: StreamEntry[], id: string, chunk: string): StreamEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, text: entry.text + chunk } : entry));
}

function withStatus(
  entries: StreamEntry[],
  id: string,
  status: StreamStatus,
  errorMessage?: string,
): StreamEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, status, errorMessage } : entry));
}

function StreamPanel() {
  const [text, setText] = useState(DEFAULT_STREAM_TEXT);
  const [delayMs, setDelayMs] = useState(80);
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [busy, setBusy] = useState(false);

  async function handleStream() {
    if (!text.trim() || busy) return;
    setBusy(true);

    const { id, done } = request(
      "stream.echo",
      { text, delayMs },
      {
        onChunk: (data) => {
          const chunk = typeof data.text === "string" ? data.text : "";
          setEntries((prev) => withAppendedChunk(prev, id, chunk));
        },
      },
    );

    setEntries((prev) => [{ id, text: "", status: "streaming" }, ...prev]);

    try {
      await done;
      setEntries((prev) => withStatus(prev, id, "done"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEntries((prev) => withStatus(prev, id, "error", message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Stream</h2>

      <div className="field">
        <label htmlFor="stream-text">Texte à streamer</label>
        <textarea
          id="stream-text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
      </div>

      <div className="field field--inline">
        <label htmlFor="stream-delay">Délai entre mots (ms)</label>
        <input
          id="stream-delay"
          type="number"
          min={0}
          max={1000}
          value={delayMs}
          onChange={(e) => setDelayMs(Number(e.currentTarget.value) || 0)}
        />
      </div>

      <div className="actions">
        <button className="btn" onClick={handleStream} disabled={busy || !text.trim()}>
          {busy ? "Streaming…" : "Streamer"}
        </button>
      </div>

      <div className="stream-history">
        {entries.length === 0 && (
          <p className="empty-hint">Aucun stream lancé pour l'instant.</p>
        )}
        {entries.map((entry) => (
          <StreamEntryView key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

const STREAM_STATE_LABELS: Record<StreamStatus, string> = {
  streaming: "en cours",
  done: "terminé",
  error: "erreur",
};

function StreamEntryView({ entry }: Readonly<{ entry: StreamEntry }>) {
  const stateLabel = STREAM_STATE_LABELS[entry.status];

  return (
    <article className="stream-entry">
      <div className="stream-entry__head">
        <span className="stream-entry__id">{entry.id}</span>
        <span className={`stream-entry__state--${entry.status}`}>{stateLabel}</span>
      </div>
      <div className="stream-entry__body">
        {entry.text}
        {entry.status === "streaming" && <span className="cursor" />}
        {entry.status === "error" && (
          <div className="result-line result-line--error">Erreur : {entry.errorMessage}</div>
        )}
      </div>
    </article>
  );
}

/* ---------- Panneau Journal (L3) ---------- */

/*
 * Chaque niveau porte un GLYPHE et un libellé en plus de sa couleur : la
 * criticité doit rester lisible sans percevoir la couleur — jamais la teinte
 * seule.
 */
const LEVEL_META: Record<LogLevel, { glyph: string; label: string; titre: string }> = {
  fatal: { glyph: "✖", label: "fatal", titre: "Fatal — l'app ou un sous-système est hors service" },
  error: { glyph: "●", label: "error", titre: "Erreur — une action a échoué" },
  warn: { glyph: "▲", label: "warn", titre: "Avertissement — dégradation acceptée" },
  info: { glyph: "■", label: "info", titre: "Info — jalon de cycle de vie" },
  debug: { glyph: "·", label: "debug", titre: "Debug — trace de mise au point" },
};

type PeriodeId = "1h" | "24h" | "7j" | "tout";

/** Périodes proposées ; `ms` = profondeur d'historique, `null` = tout le fichier. */
const PERIODES: { id: PeriodeId; label: string; ms: number | null }[] = [
  { id: "1h", label: "1 heure", ms: 3_600_000 },
  { id: "24h", label: "24 heures", ms: 24 * 3_600_000 },
  { id: "7j", label: "7 jours", ms: 7 * 24 * 3_600_000 },
  { id: "tout", label: "Tout", ms: null },
];

/** Plafond de lecture : large sans atteindre le plafond dur du contrat (5000). */
const JOURNAL_LIMIT = 2000;

/*
 * T-002 — dernier rapport de la tâche hebdomadaire `qualite-iaction`
 * (docs/etude-logs.md § 2.7) : c'est ce qui referme la boucle
 * « erreur vécue → ligne de journal → agrégat → rapport hebdo → ticket », et
 * elle doit se voir depuis l'endroit où l'on constate les erreurs.
 *
 * Tolérant par construction : la tâche n'est pas forcément installée sur le
 * poste. Sans rapport, pas de lien — et jamais de message d'erreur.
 */
const TACHE_QUALITE = "qualite-iaction";

/** Libellé d'un rapport : son nom de fichier (les rapports sont datés `AAAA-MM-JJ.md`), à défaut son mtime. */
function libelleRapport(rapport: TacheReportInfo): string {
  const sansExt = rapport.file.replace(/\.md$/i, "");
  if (sansExt) return sansExt;
  return new Date(rapport.mtimeMs).toLocaleDateString("fr-FR");
}

/** Modale de lecture du dernier rapport qualité — contenu chargé à l'ouverture. */
function RapportQualiteModal({ rapport, onClose }: Readonly<{ rapport: TacheReportInfo; onClose: () => void }>) {
  const [contenu, setContenu] = useState<string | null>(null);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    let cancelled = false;
    tachesReportRead(TACHE_QUALITE, rapport.file)
      .then((texte) => {
        if (!cancelled) setContenu(texte);
      })
      .catch((err: unknown) => {
        if (!cancelled) setErreur(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rapport.file]);

  return (
    <Modal label={`Rapport qualité du ${libelleRapport(rapport)}`} onClose={onClose}>
      <div className="orch-modal rapport-modal">
        <header className="rapport-modal__head">
          <h3>Rapport qualité · {libelleRapport(rapport)}</h3>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Fermer
          </button>
        </header>
        {erreur && <p className="empty-hint empty-hint--error">Rapport illisible : {erreur}</p>}
        {!erreur && contenu === null && <p className="empty-hint">Chargement…</p>}
        {contenu !== null && <Markdown content={contenu} />}
      </div>
    </Modal>
  );
}

type JournalEtat = "chargement" | "ok" | "indisponible" | "erreur";

/** Horodatage local court : heure seule le jour même, `JJ/MM hh:mm:ss` sinon. */
function formatHorodatage(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts || "—";
  const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const now = new Date();
  const memeJour =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (memeJour) return heure;
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${heure}`;
}

/** Clé stable d'une entrée : le journal n'a pas d'id, l'horodatage + le rang suffisent. */
function entryKey(entry: LogEntry, index: number): string {
  return `${entry.ts}#${index}`;
}

/** Une entrée en une ligne de texte (export presse-papier). */
function entryToText(entry: LogEntry): string {
  const parts = [entry.ts || "—", entry.level.toUpperCase(), entry.scope, entry.msg];
  const fields = Object.entries(entry.fields);
  if (fields.length > 0) parts.push(fields.map(([k, v]) => `${k}=${String(v)}`).join(" "));
  const corr = [
    entry.reqId ? `reqId=${entry.reqId}` : "",
    entry.runId ? `runId=${entry.runId}` : "",
    entry.stepId ? `stepId=${entry.stepId}` : "",
  ].filter(Boolean);
  if (corr.length > 0) parts.push(corr.join(" "));
  return parts.join("  ");
}

/** Rangée de compteurs par criticité : chips cliquables, seuil « au moins ce niveau ». */
function JournalCounters({
  counts,
  minLevel,
  onMinLevel,
}: Readonly<{ counts: LogCounts; minLevel: LogLevel | null; onMinLevel: (level: LogLevel | null) => void }>) {
  return (
    // <fieldset> plutôt qu'un <div role="group"> : le groupement de contrôles
    // est natif, annoncé par tous les lecteurs d'écran, et sa <legend> donne
    // au groupe un nom visible autant qu'accessible.
    <fieldset className="journal-counters">
      <legend className="journal-counters__legend">Criticité (au moins)</legend>
      {/* Rangée dans un enfant : la mise en page d'un <fieldset> est
          particulière (la <legend> est sortie du flux normal) — le flex vit
          donc dans un conteneur ordinaire, au comportement prévisible. */}
      <div className="journal-counters__row">
        {LOG_LEVELS.map((level) => {
          const meta = LEVEL_META[level];
          const actif = minLevel === level;
          return (
            <button
              key={level}
              type="button"
              className={`journal-chip journal-chip--${level}${actif ? " journal-chip--active" : ""}`}
              // Bascule : recliquer la chip active retire le filtre (retour à « tous »).
              onClick={() => onMinLevel(actif ? null : level)}
              aria-pressed={actif}
              title={`${meta.titre} — n'afficher que ${meta.label} et au-dessus`}
            >
              <span className="journal-chip__glyph" aria-hidden="true">
                {meta.glyph}
              </span>
              <span className="journal-chip__label">{meta.label}</span>
              <span className="journal-chip__count">{counts[level]}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`journal-chip journal-chip--tous${minLevel === null ? " journal-chip--active" : ""}`}
          onClick={() => onMinLevel(null)}
          aria-pressed={minLevel === null}
          title="Afficher tous les niveaux"
        >
          <span className="journal-chip__label">tous</span>
        </button>
      </div>
    </fieldset>
  );
}

/** Détail déplié d'une entrée : `fields`, corrélation, `stack`. */
function JournalDetail({ entry, id }: Readonly<{ entry: LogEntry; id: string }>) {
  const fields = Object.entries(entry.fields);
  const corr: { label: string; value: string }[] = [];
  if (entry.reqId) corr.push({ label: "reqId", value: entry.reqId });
  if (entry.runId) corr.push({ label: "runId", value: entry.runId });
  if (entry.stepId) corr.push({ label: "stepId", value: entry.stepId });
  const rien = fields.length === 0 && corr.length === 0 && !entry.stack;
  return (
    <div className="journal-detail" id={id}>
      <div className="journal-detail__ts">{entry.ts || "horodatage inconnu"}</div>
      {rien && <p className="empty-hint">Aucun détail attaché à cette entrée.</p>}
      {corr.length > 0 && (
        <dl className="journal-kv">
          {corr.map((c) => (
            <div key={c.label} className="journal-kv__row">
              <dt>{c.label}</dt>
              <dd>{c.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {fields.length > 0 && (
        <dl className="journal-kv">
          {fields.map(([k, v]) => (
            <div key={k} className="journal-kv__row">
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.stack && <pre className="journal-stack">{entry.stack}</pre>}
    </div>
  );
}

/** Modale de confirmation de la purge (convention `Modal` + `.orch-modal`). */
function PurgeConfirmModal({
  onCancel,
  onConfirm,
  busy,
}: Readonly<{ onCancel: () => void; onConfirm: () => void; busy: boolean }>) {
  return (
    <Modal label="Purger le journal" onClose={onCancel}>
      <div className="orch-modal journal-confirm">
        <div className="orch-modal__head">
          <h3>Purger le journal ?</h3>
        </div>
        <div className="orch-modal__body">
          <p className="empty-hint">
            Supprime définitivement le fichier de journal de l'application (<code>app.jsonl</code> et sa rotation{" "}
            <code>app.jsonl.1</code>). Tout l'historique d'erreurs déjà enregistré est perdu — cette action est
            irréversible.
          </p>
        </div>
        <div className="actions orch-modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="btn btn--deny" onClick={onConfirm} disabled={busy}>
            {busy ? "Purge…" : "Purger"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function JournalPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [counts, setCounts] = useState<LogCounts>(emptyCounts);
  const [truncated, setTruncated] = useState(false);
  const [etat, setEtat] = useState<JournalEtat>("chargement");
  const [erreur, setErreur] = useState("");

  const [minLevel, setMinLevel] = useState<LogLevel | null>(null);
  const [scope, setScope] = useState<LogScope | "tous">("tous");
  const [periode, setPeriode] = useState<PeriodeId>("24h");
  const [recherche, setRecherche] = useState("");

  const [deplie, setDeplie] = useState<ReadonlySet<string>>(new Set());
  const [purgeOuverte, setPurgeOuverte] = useState(false);
  const [purgeEnCours, setPurgeEnCours] = useState(false);
  /** T-002 — dernier rapport `qualite-iaction`, ou `null` (tâche non installée, aucun rapport). */
  const [rapport, setRapport] = useState<TacheReportInfo | null>(null);
  const [rapportOuvert, setRapportOuvert] = useState(false);
  const [message, setMessage] = useState("");
  /** Incrémenté par « Rafraîchir » : relance l'effet de chargement. */
  const [tick, setTick] = useState(0);

  const roving = useRovingFocus<HTMLUListElement>({ selector: ".journal-row", orientation: "vertical" });

  useEffect(() => {
    let cancelled = false;
    setEtat("chargement");
    const span = PERIODES.find((p) => p.id === periode)?.ms ?? null;
    // Filtres `minLevel`/`scope` appliqués CÔTÉ SIDECAR : `counts` est calculé
    // avant eux (contrat), donc les compteurs restent justes filtre actif.
    logRead({
      ...(minLevel !== null ? { minLevel } : {}),
      ...(scope !== "tous" ? { scope } : {}),
      ...(span !== null ? { sinceMs: Date.now() - span } : {}),
      limit: JOURNAL_LIMIT,
    })
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setCounts(res.counts);
        setTruncated(res.truncated);
        setEtat("ok");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setCounts(emptyCounts());
        setTruncated(false);
        if (estJournalIndisponible(err)) {
          setEtat("indisponible");
        } else {
          setErreur(err instanceof Error ? err.message : String(err));
          setEtat("erreur");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [minLevel, scope, periode, tick]);

  // T-002 — dernier rapport qualité, best effort : toute erreur (tâche
  // absente, sidecar sans `taches.*`) se solde par « pas de lien », jamais par
  // un message dans un panneau qui parle d'autre chose.
  useEffect(() => {
    let cancelled = false;
    tachesReports(TACHE_QUALITE)
      .then((liste) => {
        if (!cancelled) setRapport(liste[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setRapport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // TODO(L2) : brancher ici l'abonnement au tampon temps réel de
  // `ui/src/journal.ts` (complétion en direct des entrées déjà chargées) —
  // le chargement initial ci-dessus reste la source de l'historique, qui est
  // ce qui survit au redémarrage de l'app.

  // Retour d'action (copie, purge) éphémère : il informe puis s'efface seul.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);

  /*
   * Vue affichée : recherche texte côté client (le contrat ne la porte pas),
   * puis ordre ANTI-chronologique — `log.read` renvoie du plus ancien au plus
   * récent, la lecture d'un journal se fait du plus récent au plus ancien.
   */
  const affichees = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtrees = q ? entries.filter((e) => e.msg.toLowerCase().includes(q)) : entries;
    return [...filtrees].reverse();
  }, [entries, recherche]);

  function basculerDetail(key: string) {
    setDeplie((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCopier() {
    const texte = affichees.map(entryToText).join("\n");
    try {
      await navigator.clipboard.writeText(texte);
      setMessage(`${affichees.length} entrée(s) copiée(s).`);
    } catch {
      // Presse-papier refusé (contexte non sécurisé, permission) : on le dit,
      // sans casser la page — la liste reste sélectionnable à la souris.
      setMessage("Copie impossible : presse-papier inaccessible.");
    }
  }

  async function handlePurger() {
    setPurgeEnCours(true);
    try {
      await logPurge();
      setMessage("Journal purgé.");
      setPurgeOuverte(false);
      setTick((t) => t + 1);
    } catch (err) {
      setMessage(`Purge impossible : ${err instanceof Error ? err.message : String(err)}`);
      setPurgeOuverte(false);
    } finally {
      setPurgeEnCours(false);
    }
  }

  const total = LOG_LEVELS.reduce((n, level) => n + counts[level], 0);

  return (
    <section className="panel journal-panel" aria-label="Journal applicatif">
      <div className="journal-panel__head">
        <h2 className="panel__title">Journal</h2>
        <div className="actions journal-actions">
          {rapport && (
            <button
              type="button"
              className="btn btn--ghost journal-rapport"
              onClick={() => setRapportOuvert(true)}
              title={`Rapport hebdomadaire de la tâche ${TACHE_QUALITE} — top des erreurs, régressions, tickets proposés`}
            >
              ▤ Dernier rapport qualité · {libelleRapport(rapport)}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => setTick((t) => t + 1)}>
            Rafraîchir
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void handleCopier()} disabled={affichees.length === 0}>
            Copier
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setPurgeOuverte(true)} disabled={etat === "indisponible"}>
            Purger
          </button>
        </div>
      </div>

      <JournalCounters counts={counts} minLevel={minLevel} onMinLevel={setMinLevel} />

      <div className="journal-filters">
        <div className="field field--inline">
          <label htmlFor="journal-scope">Scope</label>
          <select
            id="journal-scope"
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value as LogScope | "tous")}
          >
            <option value="tous">tous</option>
            {LOG_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline">
          <label htmlFor="journal-periode">Période</label>
          <select
            id="journal-periode"
            value={periode}
            onChange={(e) => setPeriode(e.currentTarget.value as PeriodeId)}
          >
            {PERIODES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline journal-filters__search">
          <label htmlFor="journal-recherche">Rechercher</label>
          <input
            id="journal-recherche"
            type="search"
            value={recherche}
            placeholder="dans les messages…"
            onChange={(e) => setRecherche(e.currentTarget.value)}
          />
        </div>
      </div>

      {message && <div className="result-line">{message}</div>}
      {etat === "erreur" && <p className="empty-hint empty-hint--error">Journal illisible : {erreur}</p>}
      {etat === "indisponible" && (
        <p className="empty-hint">
          Journal indisponible : ce sidecar ne fournit pas encore les méthodes <code>log.*</code>. Le flux brut
          « Logs sidecar » ci-dessous reste utilisable.
        </p>
      )}
      {etat === "chargement" && <p className="empty-hint">Chargement…</p>}

      {etat === "ok" && affichees.length === 0 && (
        <p className="empty-hint">Aucune entrée sur cette période avec ces filtres.</p>
      )}

      {etat === "ok" && affichees.length > 0 && (
        <ul
          className="journal-list"
          aria-label="Entrées du journal, de la plus récente à la plus ancienne"
          ref={roving.containerRef}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
        >
          {affichees.map((entry, i) => {
            const key = entryKey(entry, i);
            const ouvert = deplie.has(key);
            const meta = LEVEL_META[entry.level];
            return (
              <li key={key} className={`journal-item journal-item--${entry.level}`}>
                <button
                  type="button"
                  className="journal-row"
                  onClick={() => basculerDetail(key)}
                  aria-expanded={ouvert}
                  aria-controls={`journal-detail-${i}`}
                  tabIndex={i === 0 ? 0 : -1}
                >
                  <span className={`journal-level journal-level--${entry.level}`}>
                    <span className="journal-level__glyph" aria-hidden="true">
                      {meta.glyph}
                    </span>
                    {meta.label}
                  </span>
                  <span className="journal-row__ts">{formatHorodatage(entry.ts)}</span>
                  <span className="journal-row__scope">{entry.scope}</span>
                  <span className="journal-row__msg" title={entry.msg}>
                    {entry.msg}
                  </span>
                  <span className="journal-row__chevron" aria-hidden="true">
                    {ouvert ? "▾" : "▸"}
                  </span>
                </button>
                {ouvert && <JournalDetail entry={entry} id={`journal-detail-${i}`} />}
              </li>
            );
          })}
        </ul>
      )}

      {etat === "ok" && (
        <p className="empty-hint">
          {affichees.length} entrée(s) affichée(s) · {total} sur la fenêtre lue
          {truncated ? " · journal plus ancien non lu (fenêtre tronquée)" : ""}
        </p>
      )}

      {rapport && rapportOuvert && (
        <RapportQualiteModal rapport={rapport} onClose={() => setRapportOuvert(false)} />
      )}

      {purgeOuverte && (
        <PurgeConfirmModal
          busy={purgeEnCours}
          onCancel={() => setPurgeOuverte(false)}
          onConfirm={() => void handlePurger()}
        />
      )}
    </section>
  );
}

/* ---------- Panneau Tickets (TK1) ---------- */

/*
 * Priorités : rampe de remplissage (⬤ ◐ ○) DOUBLÉE du libellé « P1 »/« P2 »/
 * « P3 » en toutes lettres. La teinte n'est qu'un renfort — même principe que
 * les niveaux du Journal ci-dessus, la criticité doit rester lisible sans
 * percevoir la couleur.
 */
const PRIO_META: Record<TicketPrio, { glyph: string; titre: string }> = {
  P1: { glyph: "⬤", titre: "P1 — bloquant, à faire ensuite" },
  P2: { glyph: "◐", titre: "P2 — important, pas urgent" },
  P3: { glyph: "○", titre: "P3 — confort, un jour" },
};

/** Filtre de statut : `actifs` (défaut) masque les archivés, `tous` les révèle. */
type StatutFiltre = "actifs" | TicketStatut | "tous";

const STATUT_FILTRES: { id: StatutFiltre; label: string }[] = [
  { id: "actifs", label: "actifs (sans archivés)" },
  { id: "ouvert", label: "ouvert" },
  { id: "en cours", label: "en cours" },
  { id: "fait", label: "fait" },
  { id: "abandonné", label: "abandonné" },
  { id: "tous", label: "tous (avec archivés)" },
];

type BacklogEtat = "chargement" | "ok" | "introuvable" | "indisponible" | "erreur";

function estPrioConnue(prio: string): prio is TicketPrio {
  return (TICKET_PRIOS as readonly string[]).includes(prio);
}

function correspondStatut(ticket: Ticket, filtre: StatutFiltre): boolean {
  if (filtre === "tous") return true;
  // « actifs » raisonne sur l'ARCHIVAGE, pas sur le statut : un ticket resté
  // dans « Ouverts » avec un statut exotique doit rester visible.
  if (filtre === "actifs") return !ticket.archive;
  return ticket.statut === filtre;
}

/** Rangée de compteurs par priorité + révélation des archivés (chips du Journal, mêmes codes). */
function TicketsCounters({
  parPrio,
  archives,
  prio,
  onPrio,
  archivesVisibles,
  onArchives,
}: Readonly<{
  parPrio: Record<TicketPrio, number>;
  archives: number;
  prio: TicketPrio | null;
  onPrio: (prio: TicketPrio | null) => void;
  archivesVisibles: boolean;
  onArchives: () => void;
}>) {
  return (
    <fieldset className="journal-counters">
      <legend className="journal-counters__legend">Priorité (tickets actifs)</legend>
      <div className="journal-counters__row">
        {TICKET_PRIOS.map((p) => {
          const meta = PRIO_META[p];
          const actif = prio === p;
          return (
            <button
              key={p}
              type="button"
              className={`journal-chip tickets-chip--${p}${actif ? " journal-chip--active" : ""}`}
              onClick={() => onPrio(actif ? null : p)}
              aria-pressed={actif}
              title={`${meta.titre} — n'afficher que cette priorité`}
            >
              <span className="journal-chip__glyph" aria-hidden="true">
                {meta.glyph}
              </span>
              <span className="journal-chip__label">{p}</span>
              <span className="journal-chip__count">{parPrio[p]}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`journal-chip journal-chip--tous${prio === null ? " journal-chip--active" : ""}`}
          onClick={() => onPrio(null)}
          aria-pressed={prio === null}
          title="Afficher toutes les priorités"
        >
          <span className="journal-chip__label">toutes</span>
        </button>
        {/* Les archivés sont hors de la rampe de priorité : chip à part, qui
            bascule le filtre de statut plutôt que de filtrer elle-même. */}
        <button
          type="button"
          className={`journal-chip tickets-chip--archives${archivesVisibles ? " journal-chip--active" : ""}`}
          onClick={onArchives}
          aria-pressed={archivesVisibles}
          title={archivesVisibles ? "Masquer les tickets archivés" : "Afficher aussi les tickets archivés"}
        >
          <span className="journal-chip__glyph" aria-hidden="true">
            ▣
          </span>
          <span className="journal-chip__label">archivés</span>
          <span className="journal-chip__count">{archives}</span>
        </button>
      </div>
    </fieldset>
  );
}

function TicketsPanel() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [chemin, setChemin] = useState("");
  const [etat, setEtat] = useState<BacklogEtat>("chargement");
  const [erreur, setErreur] = useState("");

  const [prio, setPrio] = useState<TicketPrio | null>(null);
  const [statut, setStatut] = useState<StatutFiltre>("actifs");
  const [type, setType] = useState<string>("tous");
  const [recherche, setRecherche] = useState("");

  const [deplie, setDeplie] = useState<ReadonlySet<string>>(new Set());
  /** Incrémenté par « Rafraîchir » : relance l'effet de chargement. */
  const [tick, setTick] = useState(0);

  const roving = useRovingFocus<HTMLUListElement>({ selector: ".tickets-row", orientation: "vertical" });

  useEffect(() => {
    let cancelled = false;
    setEtat("chargement");
    ticketsList()
      .then((res) => {
        if (cancelled) return;
        setTickets(res.tickets);
        setChemin(res.chemin);
        setEtat(res.disponible ? "ok" : "introuvable");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTickets([]);
        setChemin("");
        if (estBacklogIndisponible(err)) {
          setEtat("indisponible");
        } else {
          setErreur(err instanceof Error ? err.message : String(err));
          setEtat("erreur");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /** Compteurs par priorité sur les tickets ACTIFS : le backlog, c'est ce qui reste à faire. */
  const parPrio = useMemo(() => {
    const counts: Record<TicketPrio, number> = { P1: 0, P2: 0, P3: 0 };
    for (const t of tickets) {
      if (!t.archive && estPrioConnue(t.prio)) counts[t.prio] += 1;
    }
    return counts;
  }, [tickets]);

  const archives = useMemo(() => tickets.filter((t) => t.archive).length, [tickets]);

  const affiches = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtres = tickets.filter((t) => {
      if (!correspondStatut(t, statut)) return false;
      if (prio !== null && t.prio !== prio) return false;
      if (type !== "tous" && t.type !== type) return false;
      if (q && !`${t.id} ${t.titre} ${t.corps}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return trierTickets(filtres);
  }, [tickets, statut, prio, type, recherche]);

  function basculerDetail(id: string) {
    setDeplie((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const archivesVisibles = statut === "tous";

  return (
    <section className="panel tickets-panel" aria-label="Backlog de tickets">
      <div className="journal-panel__head">
        <h2 className="panel__title">Tickets</h2>
        <div className="actions journal-actions">
          <button type="button" className="btn btn--ghost" onClick={() => setTick((t) => t + 1)}>
            Rafraîchir
          </button>
        </div>
      </div>

      <p className="empty-hint">
        Backlog du projet, en <strong>lecture seule</strong> : <code>docs/tickets.md</code> s'édite à la main.
      </p>

      <TicketsCounters
        parPrio={parPrio}
        archives={archives}
        prio={prio}
        onPrio={setPrio}
        archivesVisibles={archivesVisibles}
        onArchives={() => setStatut(archivesVisibles ? "actifs" : "tous")}
      />

      <div className="journal-filters">
        <div className="field field--inline">
          <label htmlFor="tickets-statut">Statut</label>
          <select
            id="tickets-statut"
            value={statut}
            onChange={(e) => setStatut(e.currentTarget.value as StatutFiltre)}
          >
            {STATUT_FILTRES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline">
          <label htmlFor="tickets-type">Type</label>
          <select id="tickets-type" value={type} onChange={(e) => setType(e.currentTarget.value)}>
            <option value="tous">tous</option>
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline journal-filters__search">
          <label htmlFor="tickets-recherche">Rechercher</label>
          <input
            id="tickets-recherche"
            type="search"
            value={recherche}
            placeholder="dans les titres et les corps…"
            onChange={(e) => setRecherche(e.currentTarget.value)}
          />
        </div>
      </div>

      {etat === "erreur" && <p className="empty-hint empty-hint--error">Backlog illisible : {erreur}</p>}
      {etat === "indisponible" && (
        <p className="empty-hint">
          Backlog indisponible : ce sidecar ne fournit pas encore la méthode <code>tickets.list</code>.
        </p>
      )}
      {etat === "introuvable" && (
        <p className="empty-hint">
          Backlog introuvable : aucun fichier lisible à <code>{chemin || "(chemin inconnu)"}</code>. Normal hors du
          dépôt de développement.
        </p>
      )}
      {etat === "chargement" && <p className="empty-hint">Chargement…</p>}

      {etat === "ok" && affiches.length === 0 && <p className="empty-hint">Aucun ticket avec ces filtres.</p>}

      {etat === "ok" && affiches.length > 0 && (
        <ul
          className="tickets-list"
          aria-label="Tickets, par priorité puis par identifiant"
          ref={roving.containerRef}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
        >
          {affiches.map((ticket, i) => {
            const ouvert = deplie.has(ticket.id);
            const meta = estPrioConnue(ticket.prio) ? PRIO_META[ticket.prio] : null;
            return (
              <li key={ticket.id} className={`tickets-item${ticket.archive ? " tickets-item--archive" : ""}`}>
                <button
                  type="button"
                  className="tickets-row"
                  onClick={() => basculerDetail(ticket.id)}
                  aria-expanded={ouvert}
                  aria-controls={`tickets-detail-${ticket.id}`}
                  tabIndex={i === 0 ? 0 : -1}
                >
                  <span className={`tickets-badge tickets-badge--${ticket.type || "inconnu"}`}>
                    {ticket.type || "?"}
                  </span>
                  <span
                    className={`tickets-prio tickets-prio--${ticket.prio || "inconnue"}`}
                    title={meta?.titre ?? "priorité non renseignée"}
                  >
                    <span className="tickets-prio__glyph" aria-hidden="true">
                      {meta?.glyph ?? "·"}
                    </span>
                    {ticket.prio || "—"}
                  </span>
                  <span className="tickets-row__id">{ticket.id}</span>
                  <span className="tickets-row__titre" title={ticket.titre}>
                    {ticket.titre || "(sans titre)"}
                  </span>
                  <span className="tickets-row__statut">
                    {ticket.statut || "—"}
                    {ticket.archive ? " · archivé" : ""}
                  </span>
                  <span className="journal-row__chevron" aria-hidden="true">
                    {ouvert ? "▾" : "▸"}
                  </span>
                </button>
                {ouvert && (
                  <div className="tickets-detail" id={`tickets-detail-${ticket.id}`}>
                    {ticket.corps ? (
                      <Markdown content={ticket.corps} />
                    ) : (
                      <p className="empty-hint">
                        Pas de section détaillée pour ce ticket dans <code>tickets.md</code>.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {etat === "ok" && (
        <p className="empty-hint">
          {affiches.length} ticket(s) affiché(s) sur {tickets.length} · lu dans <code>{chemin}</code>
        </p>
      )}
    </section>
  );
}

/* ---------- Panneau Logs sidecar (flux brut, replié) ---------- */

interface LogLine {
  id: number;
  text: string;
}

let logLineCounter = 0;

function LogsPanel() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = subscribeLog((text) => {
      logLineCounter += 1;
      setLines((prev) => {
        const next = [...prev, { id: logLineCounter, text }];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    });
    return off;
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <details className="logs-panel">
      <summary>
        <span>Logs sidecar</span>
        <span className="logs-panel__count">{lines.length} ligne(s)</span>
      </summary>
      <div className="logs-panel__body" ref={bodyRef}>
        {lines.length === 0 ? (
          <p className="empty-hint">Aucun log reçu pour l'instant.</p>
        ) : (
          lines.map((line) => (
            <div className="log-line" key={line.id}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

/* ---------- Page ---------- */

export function SystemPage() {
  return (
    <div className="page system-page">
      <div className="page__intro">
        <h1 className="page__title">Système</h1>
        <p className="empty-hint">
          Journal applicatif (erreurs par criticité, historisé sur ce poste), backlog des tickets du projet, et
          panneaux de debug bas niveau : ping, écho streamé et flux brut du sidecar.
        </p>
      </div>
      {/* Le journal passe en tête : c'est la vue principale de la page. */}
      <JournalPanel />
      {/* Puis le backlog : on regarde les erreurs, puis ce qui est déjà connu
          et tracé — la suite logique de la lecture du journal. */}
      <TicketsPanel />
      <main className="panels">
        <PingPanel />
        <StreamPanel />
      </main>
      {/* Flux brut du stderr sidecar : conservé, replié, sous le journal. */}
      <LogsPanel />
    </div>
  );
}
