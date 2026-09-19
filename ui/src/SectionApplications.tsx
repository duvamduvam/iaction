/*
 * Page « Configuration » (admin), onglet « Applications » : tout ce qui
 * décide de l'ouverture d'un fichier cité dans le fil, AVEC QUOI (le
 * registre d'applications externes — extension → commande, voir
 * appsAdmin.ts) et COMMENT (au clic, ou au clic ET au survol — T-104,
 * réglage porté par survolReference.ts).
 *
 * Extrait de ProvidersPage.tsx (cliquet de taille, voir
 * scripts/cliquet-taille.json) : la section « Applications » est reprise
 * telle quelle, la section « Ouverture au survol » est nouvelle.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addApp,
  deleteApp,
  parseExtensions,
  readApps,
  updateApp,
  type AppEntry,
} from "./appsAdmin";
import {
  chargerSurvol,
  enregistrerSurvol,
  SURVOL_DEFAUT,
  SURVOL_DELAI_MAX,
  SURVOL_DELAI_MIN,
  type ReglageSurvol,
} from "./survolReference";

type AppsLoadState = "loading" | "ready" | "error";

interface AppFormValues {
  label: string;
  command: string;
  extensionsRaw: string;
}

function AppForm({
  mode,
  initial,
  onSubmit,
  onCancel,
}: Readonly<{
  mode: "add" | "edit";
  initial?: AppFormValues;
  onSubmit: (values: { label: string; command: string; extensions: string[] }) => Promise<void>;
  onCancel: () => void;
}>) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [extensionsRaw, setExtensionsRaw] = useState(initial?.extensionsRaw ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = label.trim().length > 0 && command.trim().length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        label: label.trim(),
        command: command.trim(),
        extensions: parseExtensions(extensionsRaw),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="app-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="field">
        <label htmlFor={`af-label-${mode}`}>Libellé</label>
        <input
          id={`af-label-${mode}`}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="ex. KiCad"
        />
      </div>
      <div className="field">
        <label htmlFor={`af-command-${mode}`}>Commande</label>
        <input
          id={`af-command-${mode}`}
          value={command}
          onChange={(e) => setCommand(e.currentTarget.value)}
          placeholder="ex. kicad"
        />
      </div>
      <div className="field">
        <label htmlFor={`af-ext-${mode}`}>Extensions</label>
        <input
          id={`af-ext-${mode}`}
          value={extensionsRaw}
          onChange={(e) => setExtensionsRaw(e.currentTarget.value)}
          placeholder="ex. kicad_pcb, kicad_sch pdf"
        />
      </div>
      {error && <div className="result-line result-line--error">Erreur : {error}</div>}
      <div className="actions">
        <button type="submit" className="btn" disabled={!canSubmit || saving}>
          {saving ? "Enregistrement…" : mode === "add" ? "Ajouter" : "Enregistrer"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function AppCard({
  app,
  onEdit,
  onDelete,
}: Readonly<{
  app: AppEntry;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  return (
    <article className="app-card">
      <div className="app-card__head">
        <span className="app-card__label">{app.label}</span>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={onEdit} aria-label={`Modifier ${app.label}`} title="Modifier">
            ✎
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDelete}
            aria-label={`Supprimer ${app.label}`}
            title="Supprimer"
          >
            Supprimer
          </button>
        </div>
      </div>
      <div className="app-card__command">{app.command}</div>
      <div className="app-card__extensions">
        {app.extensions.length === 0 ? (
          <span className="empty-hint">Aucune extension associée.</span>
        ) : (
          app.extensions.map((ext) => (
            <span className="app-extension-badge" key={ext}>
              .{ext}
            </span>
          ))
        )}
      </div>
    </article>
  );
}

function AppsSection() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loadState, setLoadState] = useState<AppsLoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    // StrictMode-safe : même pattern que useProjects/useProviders (voir leur en-tête).
    if (initialized.current) return;
    initialized.current = true;
    readApps()
      .then((list) => {
        setApps(list);
        setLoadState("ready");
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setLoadState("error");
      });
  }, []);

  const editingApp = apps.find((a) => a.id === editingId) ?? null;

  return (
    <section className="config-section">
      <h2 className="config-section__title">Applications</h2>
      <p className="empty-hint">
        Ouvrir un fichier de l'arborescence avec une application externe (KiCad, LibreOffice…),
        selon son extension. Sans règle correspondante, IAction utilise l'application système
        par défaut (xdg-open sous Linux).
      </p>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && (
        <div className="result-line result-line--error">Erreur de chargement : {errorMessage}</div>
      )}

      <div className="app-list">
        {apps.map((app) =>
          editingId === app.id && editingApp ? (
            <article className="app-card" key={app.id}>
              <AppForm
                mode="edit"
                initial={{ label: editingApp.label, command: editingApp.command, extensionsRaw: editingApp.extensions.join(", ") }}
                onSubmit={async (values) => {
                  const next = await updateApp(app.id, values);
                  setApps(next);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </article>
          ) : (
            <AppCard
              key={app.id}
              app={app}
              onEdit={() => setEditingId(app.id)}
              onDelete={() => {
                if (window.confirm(`Supprimer la règle « ${app.label} » ?`)) {
                  void deleteApp(app.id).then(setApps);
                }
              }}
            />
          ),
        )}
        {apps.length === 0 && loadState === "ready" && <p className="empty-hint">Aucune application déclarée.</p>}
      </div>

      {adding ? (
        <article className="app-card app-card--new">
          <AppForm
            mode="add"
            onSubmit={async (values) => {
              const next = await addApp(values.label, values.command, values.extensions);
              setApps(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </article>
      ) : (
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            + Ajouter une application
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Borne un délai saisi à [SURVOL_DELAI_MIN, SURVOL_DELAI_MAX] ; une saisie
 * vide ou non numérique retombe sur le défaut plutôt que d'écrire n'importe
 * quoi (T-104).
 */
function borneDelai(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return SURVOL_DEFAUT.delaiMs;
  return Math.min(SURVOL_DELAI_MAX, Math.max(SURVOL_DELAI_MIN, parsed));
}

function SectionSurvol() {
  const [reglage, setReglage] = useState<ReglageSurvol>(SURVOL_DEFAUT);
  /*
   * Le délai a une saisie À PART, en texte, et ne rejoint le réglage qu'à la
   * validation (perte du focus ou Entrée). Borner à chaque frappe rendait le
   * champ inutilisable : taper « 1000 » commence par « 1 », aussitôt ramené à
   * 250 par la borne basse — plus moyen d'atteindre la valeur voulue. Accessoirement,
   * chaque touche écrivait le fichier de config.
   */
  const [delaiSaisi, setDelaiSaisi] = useState(String(SURVOL_DEFAUT.delaiMs));
  const [erreur, setErreur] = useState("");
  const initialized = useRef(false);

  useEffect(() => {
    // StrictMode-safe : même pattern que AppsSection ci-dessus.
    if (initialized.current) return;
    initialized.current = true;
    chargerSurvol()
      .then((r) => {
        setReglage(r);
        setDelaiSaisi(String(r.delaiMs));
      })
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : String(err)));
  }, []);

  /** Valide la saisie en cours : borne, réaffiche la valeur retenue, enregistre. */
  function validerDelai() {
    const delaiMs = borneDelai(delaiSaisi);
    setDelaiSaisi(String(delaiMs));
    if (delaiMs !== reglage.delaiMs) enregistrer({ ...reglage, delaiMs });
  }

  function enregistrer(next: ReglageSurvol) {
    setReglage(next);
    enregistrerSurvol(next)
      .then(() => setErreur(""))
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : String(err)));
  }

  return (
    <section className="config-section">
      <h2 className="config-section__title">Ouverture au survol</h2>
      <p className="empty-hint">
        Dans le fil de la page Projets, une référence de fichier citée par le modèle est une
        puce cliquable. Activée, cette option l'ouvre AUSSI au simple survol de la souris, après
        le délai indiqué. Le clic continue de fonctionner ; le survol ne s'arme jamais au doigt
        (écran tactile, pas de survol) ; et sortir de la puce avant la fin du délai annule
        l'ouverture. Le réglage s'applique tout de suite dans cette fenêtre, et au prochain
        démarrage pour les fenêtres déjà ouvertes ailleurs.
      </p>

      <label className="field field--checkbox" htmlFor="survol-actif">
        <input
          id="survol-actif"
          type="checkbox"
          checked={reglage.actif}
          onChange={(e) => enregistrer({ ...reglage, actif: e.currentTarget.checked })}
        />
        <span>Ouvrir au survol, sans clic</span>
      </label>

      <div className="field">
        <label htmlFor="survol-delai">Délai avant ouverture (ms)</label>
        <input
          id="survol-delai"
          type="number"
          min={SURVOL_DELAI_MIN}
          max={SURVOL_DELAI_MAX}
          step={50}
          value={delaiSaisi}
          disabled={!reglage.actif}
          onChange={(e) => setDelaiSaisi(e.currentTarget.value)}
          onBlur={validerDelai}
          onKeyDown={(e) => {
            if (e.key === "Enter") validerDelai();
          }}
        />
      </div>

      {erreur && <div className="result-line result-line--error">Erreur : {erreur}</div>}
    </section>
  );
}

/** Composant exporté : « Applications » (registre) suivie de « Ouverture au survol » (T-104). */
export function SectionApplications() {
  return (
    <>
      <AppsSection />
      <SectionSurvol />
    </>
  );
}
