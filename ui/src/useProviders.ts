/*
 * Hook d'état des fournisseurs pour toute l'app : charge la config au
 * montage (pré-remplit les fournisseurs par défaut au premier lancement),
 * pousse la table au sidecar (`providers.set`) au démarrage et à chaque
 * changement, et expose les actions d'édition pour la page « Fournisseurs ».
 *
 * Robustesse au démarrage : la liste est affichée dès que la config est lue,
 * même si la poussée vers le sidecar échoue (il peut ne pas encore être
 * prêt) ; la poussée initiale est retentée avec délai, et la table est
 * re-poussée à chaque événement `ready` du sidecar — son état étant en
 * mémoire, un redémarrage du sidecar la perdrait sinon.
 *
 * Le `useRef` d'initialisation évite un double chargement/double push en
 * StrictMode (montage/démontage/remontage en dev).
 */
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROVIDERS,
  deleteProviderKey,
  pushProviders,
  readProviders,
  setProviderKey,
  writeProviders,
  type ProviderConfig,
} from "./providerAdmin";
import { notifyProvidersPushed } from "./providersBus";
import { subscribeReady } from "./sidecar";

export type ProvidersLoadState = "loading" | "ready" | "error";

export interface UseProvidersResult {
  providers: ProviderConfig[];
  keyStatus: Record<string, boolean>;
  loadState: ProvidersLoadState;
  errorMessage: string;
  saveProvider: (provider: ProviderConfig) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  saveKey: (id: string, value: string) => Promise<void>;
  clearKey: (id: string) => Promise<void>;
}

const PUSH_RETRY_DELAY_MS = 700;
const PUSH_RETRY_MAX = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? "erreur inconnue";
  } catch {
    return "erreur inconnue";
  }
}

export function useProviders(): UseProvidersResult {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [loadState, setLoadState] = useState<ProvidersLoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const initialized = useRef(false);
  // Liste courante accessible depuis l'abonnement `ready` sans re-souscrire.
  const providersRef = useRef<ProviderConfig[]>([]);

  async function pushWithState(list: ProviderConfig[]): Promise<void> {
    const result = await pushProviders(list);
    setKeyStatus(result.keyStatus);
    setErrorMessage("");
    // Signale aux consommateurs (listes de modèles, panneau Ollama…) que le
    // sidecar connaît désormais la table — ils relancent leurs requêtes
    // parties trop tôt (« fournisseur inconnu » au démarrage sinon).
    notifyProvidersPushed();
  }

  useEffect(() => {
    // Re-pousse la table au sidecar à chaque `ready` (démarrage tardif ou
    // redémarrage après crash : sa table en mémoire repart de zéro).
    // Souscrit à CHAQUE montage de l'effet (StrictMode compris).
    const unsubscribe = subscribeReady(() => {
      if (providersRef.current.length === 0) return;
      pushWithState(providersRef.current).catch((err) => {
        setErrorMessage(toMessage(err));
      });
    });

    // L'init ne tourne qu'une fois. ATTENTION StrictMode : le premier effet
    // est démonté/remonté mais l'ÉTAT du composant survit — il ne faut donc
    // surtout pas « annuler » les setState de cette init au démontage,
    // sinon ils ne s'appliquent jamais (l'init n'est pas relancée).
    if (!initialized.current) {
      initialized.current = true;

      (async () => {
        try {
          let list = await readProviders();
          if (list.length === 0) {
            list = DEFAULT_PROVIDERS;
            await writeProviders(list);
          }

          // La config est la source de vérité : on l'affiche tout de suite,
          // même si le sidecar n'est pas encore joignable.
          providersRef.current = list;
          setProviders(list);
          setLoadState("ready");

          // Poussée initiale avec retentatives (le sidecar peut être en cours
          // de démarrage ; providers.set échoue tant qu'il n'est pas prêt).
          // On lit providersRef à chaque tentative : si l'utilisateur a édité
          // la liste entre-temps, on ne re-pousse pas une table périmée.
          let lastError: unknown = null;
          for (let attempt = 0; attempt < PUSH_RETRY_MAX; attempt++) {
            try {
              await pushWithState(providersRef.current);
              return;
            } catch (err) {
              lastError = err;
              await sleep(PUSH_RETRY_DELAY_MS);
            }
          }
          if (lastError) {
            setErrorMessage(toMessage(lastError));
          }
        } catch (err) {
          setErrorMessage(toMessage(err));
          setLoadState("error");
        }
      })();
    }

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyProviders(next: ProviderConfig[]): Promise<void> {
    await writeProviders(next);
    providersRef.current = next;
    setProviders(next);
    await pushWithState(next);
  }

  async function saveProvider(provider: ProviderConfig): Promise<void> {
    const exists = providers.some((p) => p.id === provider.id);
    const next = exists
      ? providers.map((p) => (p.id === provider.id ? provider : p))
      : [...providers, provider];
    await applyProviders(next);
  }

  async function deleteProvider(id: string): Promise<void> {
    const next = providers.filter((p) => p.id !== id);
    await applyProviders(next);
    await deleteProviderKey(id);
  }

  async function saveKey(id: string, value: string): Promise<void> {
    await setProviderKey(id, value);
    await pushWithState(providers);
  }

  async function clearKey(id: string): Promise<void> {
    await deleteProviderKey(id);
    await pushWithState(providers);
  }

  return { providers, keyStatus, loadState, errorMessage, saveProvider, deleteProvider, saveKey, clearKey };
}
