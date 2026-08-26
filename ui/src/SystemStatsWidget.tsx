/*
 * Sonde système de l'en-tête (CPU / RAM / GPU) — l'anneau de chaque jauge.
 *
 * Extrait d'`App.tsx` le 2026-08-26 en corrigeant T-054 : le sondage GPU s'y
 * cachait au milieu de sept cents lignes de coquille, et c'est ce qui a permis
 * à `nvidia-smi` d'être relancé toutes les cinq secondes pendant des semaines
 * sans que personne relise l'appel. La fréquence du sondage se lit maintenant
 * en tête de fichier, à côté du seul composant qui s'en sert.
 *
 * Le masquage de la fenêtre de console, lui, est côté Rust
 * (`src-tauri/src/system_probe.rs`) : c'est là que le process est lancé.
 */
import { useEffect, useState } from "react";

import { Donut } from "./Donut";
import { systemStats, type SystemStats } from "./systemClient";

const SYSTEM_STATS_INTERVAL_MS = 5000;

function formatGb(mb: number): string {
  return (mb / 1024).toFixed(1).replace(".", ",");
}

/**
 * Plage de remplissage de l'anneau de température : 30 °C (machine au repos)
 * = anneau vide, 100 °C (limite thermique) = anneau plein. Nécessaire parce
 * que `usageLevel` raisonne en POURCENTAGE : lui passer 72 °C bruts le ferait
 * conclure « ok » à 72 % alors que 72 °C est déjà chaud.
 */
const TEMP_MIN_C = 30;
const TEMP_MAX_C = 100;

function tempPct(celsius: number): number {
  return ((celsius - TEMP_MIN_C) / (TEMP_MAX_C - TEMP_MIN_C)) * 100;
}

/** Vue minimale de l'utilisation machine dans l'en-tête (poll 5 s). */
export function SystemStatsWidget() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      systemStats()
        .then((s) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {
          /* sonde indisponible : l'encart reste vide */
        });
    };
    tick();
    const interval = setInterval(tick, SYSTEM_STATS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!stats) return null;
  const ramPct =
    stats.memTotalMb > 0 ? (stats.memUsedMb / stats.memTotalMb) * 100 : 0;
  const ramDetail = `${formatGb(stats.memUsedMb)}/${formatGb(stats.memTotalMb)}G`;
  const gpuMemDetail =
    stats.gpuMemUsedMb !== null && stats.gpuMemTotalMb !== null
      ? ` — mémoire ${formatGb(stats.gpuMemUsedMb)}/${formatGb(stats.gpuMemTotalMb)}G`
      : "";
  return (
    <div className="system-stats" title="Utilisation machine (rafraîchie toutes les 5 s)">
      {stats.cpuPct !== null && (
        <Donut label="CPU" pct={stats.cpuPct} title={`Processeur : ${Math.round(stats.cpuPct)} %`} />
      )}
      {stats.cpuTempC !== null && (
        <Donut
          label="T.CPU"
          pct={tempPct(stats.cpuTempC)}
          text={`${Math.round(stats.cpuTempC)}°`}
          title={`Température processeur : ${Math.round(stats.cpuTempC)} °C`}
        />
      )}
      <Donut label="RAM" pct={ramPct} title={`Mémoire : ${ramDetail}`} />
      {stats.ramTempC !== null && (
        <Donut
          label="T.RAM"
          pct={tempPct(stats.ramTempC)}
          text={`${Math.round(stats.ramTempC)}°`}
          title={`Température mémoire : ${Math.round(stats.ramTempC)} °C`}
        />
      )}
      {stats.gpuPct !== null && (
        <Donut
          label="GPU"
          pct={stats.gpuPct}
          title={`Carte graphique : ${Math.round(stats.gpuPct)} %${gpuMemDetail}`}
        />
      )}
      {stats.gpuTempC !== null && (
        <Donut
          label="T.GPU"
          pct={tempPct(stats.gpuTempC)}
          text={`${Math.round(stats.gpuTempC)}°`}
          title={`Température carte graphique : ${Math.round(stats.gpuTempC)} °C`}
        />
      )}
    </div>
  );
}
