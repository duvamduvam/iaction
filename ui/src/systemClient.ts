/*
 * Wrappers typés des commandes Tauri « poste de travail » (voir
 * docs/protocol.md § Commandes Tauri poste de travail) : lancement d'un
 * terminal dans un répertoire, et sonde CPU/RAM/GPU de l'en-tête.
 */
import { invoke } from "@tauri-apps/api/core";

/** Ouvre un terminal système dans `path` (repli home). Renvoie le répertoire retenu. */
export async function openTerminal(path: string | null): Promise<string> {
  return invoke<string>("open_terminal", { path });
}

export interface SystemStats {
  /** % CPU global depuis l'appel précédent — null au premier appel (mesure par delta). */
  cpuPct: number | null;
  memUsedMb: number;
  memTotalMb: number;
  /** GPU NVIDIA via nvidia-smi — null si absent/en échec. */
  gpuPct: number | null;
  gpuMemUsedMb: number | null;
  gpuMemTotalMb: number | null;
  /** Température GPU en °C — même source que les champs GPU ci-dessus. */
  gpuTempC: number | null;
  /** Température du processeur en °C — null si la machine n'a pas de capteur. */
  cpuTempC: number | null;
  /** Température de la mémoire en °C — null si aucun capteur (cas courant). */
  ramTempC: number | null;
}

export async function systemStats(): Promise<SystemStats> {
  return invoke<SystemStats>("system_stats");
}
