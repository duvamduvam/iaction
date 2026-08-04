/*
 * Panneau « Modèles Ollama » : affiché sous le sélecteur de modèle de la
 * section LLM (Chat et Projets), uniquement quand le fournisseur sélectionné
 * répond comme un serveur Ollama (voir docs/protocol.md, `ollama.*`). Sonde
 * `ollama.ps` au montage et à chaque changement de provider ; erreur (pas un
 * Ollama, hors ligne…) → le panneau reste masqué, sans message d'erreur —
 * c'est le comportement attendu, pas un cas d'échec à signaler.
 */
import { useCallback, useEffect, useState } from "react";
import { subscribeProvidersPushed } from "./providersBus";
import { ollamaLoad, ollamaPs, ollamaUnload, type OllamaModelInfo } from "./sidecar";

const OLLAMA_POLL_INTERVAL_MS = 10_000;

interface OllamaPanelProps {
  providerId: string;
  selectedModel: string;
}

interface BusyState {
  model: string;
  kind: "load" | "unload";
}

export function OllamaPanel({ providerId, selectedModel }: Readonly<OllamaPanelProps>) {
  const [visible, setVisible] = useState(false);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [busyError, setBusyError] = useState("");

  // Sonde unique, réutilisée par le montage/polling ET par le refresh
  // immédiat après un load/unload réussi. `providerId` seul en dépendance :
  // pas de piège de closure, la fonction est recréée à chaque changement de
  // fournisseur (et l'effet ci-dessous en dépend donc aussi).
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const list = await ollamaPs(providerId);
      setVisible(true);
      setModels(list);
      return true;
    } catch {
      setVisible(false);
      setModels([]);
      return false;
    }
  }, [providerId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }

    async function tick() {
      const ok = await refresh();
      if (cancelled) return;
      // Ne poll que tant que le panneau reste visible (Ollama confirmé) : une
      // fois masqué (erreur), on arrête de sonder jusqu'au prochain montage
      // (changement de fournisseur) — voir docs/protocol.md, `ollama.ps`.
      if (ok) {
        if (timer === null) {
          timer = setInterval(() => void tick(), OLLAMA_POLL_INTERVAL_MS);
        }
      } else {
        stop();
      }
    }

    // Réinitialisation immédiate au changement de fournisseur : évite un
    // flash de l'état du provider précédent pendant la nouvelle sonde.
    setVisible(false);
    setModels([]);
    setBusy(null);
    setBusyError("");
    void tick();

    // Re-sonde quand la table des fournisseurs atteint (enfin) le sidecar :
    // au démarrage, la première sonde part souvent avant providers.set,
    // échoue en « fournisseur inconnu » et masquait le panneau pour de bon.
    const offPushed = subscribeProvidersPushed(() => void tick());

    return () => {
      cancelled = true;
      offPushed();
      stop();
    };
  }, [refresh]);

  async function handleLoad(model: string) {
    if (busy) return;
    setBusy({ model, kind: "load" });
    setBusyError("");
    try {
      await ollamaLoad(providerId, model);
      await refresh();
    } catch (err) {
      setBusyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleUnload(model: string) {
    if (busy) return;
    setBusy({ model, kind: "unload" });
    setBusyError("");
    try {
      await ollamaUnload(providerId, model);
      await refresh();
    } catch (err) {
      setBusyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!visible) return null;

  const selectedLoaded = models.some((m) => m.name === selectedModel);

  return (
    <div className="ollama-panel">
      <div className="ollama-panel__title">Modèles Ollama</div>

      {models.length === 0 ? (
        <div className="ollama-panel__empty">Aucun modèle en mémoire</div>
      ) : (
        <ul className="ollama-panel__list">
          {models.map((m) => {
            const unloading = busy?.kind === "unload" && busy.model === m.name;
            return (
              <li key={m.name} className="ollama-panel__item">
                <span className="ollama-panel__dot" aria-hidden="true" />
                <span className="ollama-panel__name" title={m.name}>
                  {m.name}
                </span>
                {/* size_vram = 0 : modèle chargé côté CPU (RAM), pas sur le GPU. */}
                {m.sizeVram !== null && m.sizeVram > 0 && (
                  <span className="ollama-panel__vram">{(m.sizeVram / 1e9).toFixed(1)} Go VRAM</span>
                )}
                {(m.sizeVram === null || m.sizeVram === 0) && m.sizeTotal !== null && (
                  <span className="ollama-panel__vram">{(m.sizeTotal / 1e9).toFixed(1)} Go RAM</span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost ollama-panel__action"
                  onClick={() => void handleUnload(m.name)}
                  disabled={busy !== null}
                >
                  {unloading ? (
                    <>
                      <span className="ollama-panel__spinner" aria-hidden="true" />
                      Déchargement…
                    </>
                  ) : (
                    "⏏ Décharger"
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedModel && !selectedLoaded && (
        <button
          type="button"
          className="btn btn--ghost ollama-panel__action ollama-panel__load"
          onClick={() => void handleLoad(selectedModel)}
          disabled={busy !== null}
        >
          {busy?.kind === "load" && busy.model === selectedModel ? (
            <>
              <span className="ollama-panel__spinner" aria-hidden="true" />
              Chargement…
            </>
          ) : (
            `Charger ${selectedModel}`
          )}
        </button>
      )}

      {busyError && <div className="result-line result-line--error">{busyError}</div>}
    </div>
  );
}
