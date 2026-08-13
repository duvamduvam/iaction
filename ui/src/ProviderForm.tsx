/*
 * Formulaire d'ajout / modification d'un fournisseur.
 *
 * Sorti de ProvidersPage.tsx le 2026-08-11 avec R8-A : la page était à son
 * plafond de cliquet, et ce formulaire est de toute façon l'unité qui a sa
 * propre logique (contrat R0, profil R8, préréglages). Le contrat lui-même
 * reste dans providerFormCalc.ts / providerTraits.ts, testés sans DOM ; ce fichier
 * n'est que la saisie.
 */
import { useState, type FormEvent } from "react";

import { construireFournisseur, fournisseurRecevable, type ProviderFormValues } from "./providerFormCalc";
import { PROFILS_CONNUS, bodyExtrasRecevable, type ProfilConnu } from "./providerTraits";

export function ProviderForm({
  mode,
  initial,
  existingIds,
  onSubmit,
  onCancel,
}: Readonly<{
  mode: "add" | "edit";
  initial?: ProviderFormValues;
  existingIds: string[];
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
}>) {
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [needsKey, setNeedsKey] = useState(initial?.needsKey ?? false);
  // R0 — routage OpenRouter (saisie libre : ids séparés par virgules ou retours ligne).
  const [fallbackModelsText, setFallbackModelsText] = useState(
    initial?.fallbackModels?.join(", ") ?? "",
  );
  const [priceSort, setPriceSort] = useState(initial?.priceSort ?? false);
  const [usageAccounting, setUsageAccounting] = useState(initial?.usageAccounting ?? false);
  // R8-A — profil du fournisseur. La comptabilité est réputée FIABLE par
  // défaut : c'est le cas de tous les fournisseurs sauf ceux qui renvoient des
  // compteurs à zéro, et un défaut qui décrit la majorité se remarque moins.
  const [catalogUrl, setCatalogUrl] = useState(initial?.traits?.catalogUrl ?? "");
  const [catalogShape, setCatalogShape] = useState<string>(initial?.traits?.catalogShape ?? "");
  const [usageTrustworthy, setUsageTrustworthy] = useState(
    initial?.traits?.usageTrustworthy !== false,
  );
  const [bodyExtrasText, setBodyExtrasText] = useState(
    initial?.traits?.bodyExtras ? JSON.stringify(initial.traits.bodyExtras, null, 2) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const trimmedId = id.trim();
  const idTaken = mode === "add" && existingIds.includes(trimmedId);
  const extrasOk = bodyExtrasRecevable(bodyExtrasText);
  const canSubmit = fournisseurRecevable({ id, label, baseUrl }, existingIds, mode) && extrasOk;

  /** Un préréglage ne fait que PRÉ-REMPLIR : tout reste modifiable ensuite. */
  function appliquerProfil(profil: ProfilConnu) {
    if (mode === "add") {
      if (trimmedId.length === 0) setId(profil.id);
      if (label.trim().length === 0) setLabel(profil.label);
    }
    setBaseUrl(profil.baseUrl);
    setNeedsKey(profil.needsKey);
    setCatalogUrl(profil.traits?.catalogUrl ?? "");
    setCatalogShape(profil.traits?.catalogShape ?? "");
    setUsageTrustworthy(profil.traits?.usageTrustworthy !== false);
    setBodyExtrasText(
      profil.traits?.bodyExtras ? JSON.stringify(profil.traits.bodyExtras, null, 2) : "",
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError("");
    try {
      // R0/R8 — champ vide (ou case décochée) → propriété absente (opt-in pur) :
      // le contrat vit dans construireFournisseur, avec ses tests.
      await onSubmit(
        construireFournisseur({
          id,
          label,
          baseUrl,
          needsKey,
          fallbackModelsText,
          priceSort,
          usageAccounting,
          catalogUrl,
          catalogShape,
          usageTrustworthy,
          bodyExtrasText,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="provider-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="field">
        <label htmlFor={`pf-preset-${mode}`}>Préréglage</label>
        <select
          id={`pf-preset-${mode}`}
          value=""
          onChange={(e) => {
            const profil = PROFILS_CONNUS.find((p) => p.id === e.currentTarget.value);
            if (profil) appliquerProfil(profil);
          }}
        >
          <option value="">Choisir…</option>
          {PROFILS_CONNUS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="empty-hint">
          Remplit l'URL et le profil d'une plateforme connue. Simple aide de saisie : tout reste
          modifiable, et rien n'est décidé par la marque à l'exécution.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`pf-id-${mode}`}>Identifiant</label>
        <input
          id={`pf-id-${mode}`}
          value={id}
          onChange={(e) => setId(e.currentTarget.value)}
          disabled={mode === "edit"}
          placeholder="ex. mon-fournisseur"
        />
      </div>
      <div className="field">
        <label htmlFor={`pf-label-${mode}`}>Libellé</label>
        <input
          id={`pf-label-${mode}`}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="ex. Mon fournisseur"
        />
      </div>
      <div className="field">
        <label htmlFor={`pf-url-${mode}`}>URL de base</label>
        <input
          id={`pf-url-${mode}`}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
          placeholder="https://…/v1"
        />
      </div>
      <label className="field field--checkbox" htmlFor={`pf-needskey-${mode}`}>
        <input
          id={`pf-needskey-${mode}`}
          type="checkbox"
          checked={needsKey}
          onChange={(e) => setNeedsKey(e.currentTarget.checked)}
        />
        <span>Clé API requise</span>
      </label>
      {/* R0 — sous-section routage OpenRouter (opt-in : rien d'envoyé si non renseigné). */}
      <p className="empty-hint">
        <strong>Routage OpenRouter (optionnel)</strong> — ces réglages sont transmis tels quels dans
        les requêtes de chat. Un serveur OpenAI-compatible strict pourrait les rejeter : dans ce cas,
        laissez-les simplement vides.
      </p>
      <div className="field">
        <label htmlFor={`pf-fallback-${mode}`}>Modèles de secours</label>
        <textarea
          id={`pf-fallback-${mode}`}
          rows={2}
          value={fallbackModelsText}
          onChange={(e) => setFallbackModelsText(e.currentTarget.value)}
          placeholder="ids séparés par des virgules ou retours ligne"
        />
        <p className="empty-hint">
          Essayés dans l'ordre si le modèle demandé est indisponible (rate-limit, contexte, panne).
        </p>
      </div>
      <label className="field field--checkbox" htmlFor={`pf-pricesort-${mode}`}>
        <input
          id={`pf-pricesort-${mode}`}
          type="checkbox"
          checked={priceSort}
          onChange={(e) => setPriceSort(e.currentTarget.checked)}
        />
        <span>Trier par prix</span>
      </label>
      <p className="empty-hint">Chaque appel part vers l'endpoint le moins cher du modèle.</p>
      <label className="field field--checkbox" htmlFor={`pf-usageacc-${mode}`}>
        <input
          id={`pf-usageacc-${mode}`}
          type="checkbox"
          checked={usageAccounting}
          onChange={(e) => setUsageAccounting(e.currentTarget.checked)}
        />
        <span>Comptabilité d'usage</span>
      </label>
      <p className="empty-hint">
        Historise le coût réel et les tokens servis depuis le cache (Supervision).
      </p>
      {/* R8-A — sous-section profil (opt-in : rien d'envoyé si non renseigné). */}
      <p className="empty-hint">
        <strong>Profil du fournisseur (optionnel)</strong> — les écarts de cette plateforme par
        rapport au dialecte OpenAI standard. Tout laisser vide = comportement standard.
      </p>
      <div className="field">
        <label htmlFor={`pf-catalogurl-${mode}`}>URL du catalogue</label>
        <input
          id={`pf-catalogurl-${mode}`}
          value={catalogUrl}
          onChange={(e) => setCatalogUrl(e.currentTarget.value)}
          placeholder="https://…/public/bots"
        />
        <p className="empty-hint">
          Certaines plateformes publient leur catalogue ailleurs que sur <code>/models</code>. Vide =
          comportement standard.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`pf-catalogshape-${mode}`}>Forme du catalogue</label>
        <select
          id={`pf-catalogshape-${mode}`}
          value={catalogShape}
          onChange={(e) => setCatalogShape(e.currentTarget.value)}
        >
          <option value="">Standard (OpenAI)</option>
          <option value="slugs">Liste de slugs</option>
        </select>
        <p className="empty-hint">
          « Liste de slugs » lit <code>slug</code>/<code>name</code> et ne garde que les entrées
          conversationnelles (une entrée d'export ou de transcription n'est pas un modèle de chat).
        </p>
      </div>
      <label className="field field--checkbox" htmlFor={`pf-usagetrust-${mode}`}>
        <input
          id={`pf-usagetrust-${mode}`}
          type="checkbox"
          checked={usageTrustworthy}
          onChange={(e) => setUsageTrustworthy(e.currentTarget.checked)}
        />
        <span>Comptabilité fiable</span>
      </label>
      <p className="empty-hint">
        Décochez si ce fournisseur renvoie des compteurs de jetons à zéro : ils seront traités comme
        inconnus plutôt que comme une consommation nulle.
      </p>
      <div className="field">
        <label htmlFor={`pf-bodyextras-${mode}`}>Champs supplémentaires (JSON)</label>
        <textarea
          id={`pf-bodyextras-${mode}`}
          rows={3}
          value={bodyExtrasText}
          onChange={(e) => setBodyExtrasText(e.currentTarget.value)}
          placeholder={'{"stateless": true}'}
        />
        <p className="empty-hint">
          Fusionnés dans le corps de chaque requête de chat. Les clés du cœur de la requête
          (<code>model</code>, <code>messages</code>, <code>stream</code>) sont ignorées.
        </p>
        {!extrasOk && (
          <div className="result-line result-line--error">
            JSON invalide : attendu un objet, par exemple {'{"stateless": true}'}.
          </div>
        )}
      </div>
      {idTaken && <div className="result-line result-line--error">Identifiant déjà utilisé.</div>}
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
