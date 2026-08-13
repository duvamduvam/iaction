/*
 * Camembert (anneau SVG) partagé par tous les encarts de l'en-tête : conso
 * Claude, contexte du fil, sonde système (CPU/RAM/GPU et températures).
 *
 * Extrait d'App.tsx : la jauge n'a aucune dépendance à l'état de l'appli, et
 * trois encarts distincts s'en servent — la laisser dans le fichier-dieu ne
 * faisait que l'alourdir. Les styles vivent dans App.css (`.usage-donut`).
 */

/** Seuils de couleur communs à toutes les jauges, en POURCENTAGE. */
export function usageLevel(pct: number): "ok" | "warn" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warn";
  return "ok";
}

/**
 * Camembert (anneau SVG) de consommation : rempli = part consommée. Couleur
 * par niveau (ok/warn/error, mêmes seuils que les jauges historiques).
 *
 * `pct` est TOUJOURS un pourcentage de remplissage (0-100) : une grandeur qui
 * n'en est pas une — une température, par exemple — doit être ramenée à une
 * proportion par l'appelant, qui passe alors le texte lisible via `text`.
 */
export function Donut({
  label,
  pct,
  text,
  title,
}: Readonly<{ label: string; pct: number; text?: string; title: string }>) {
  const bounded = Math.min(100, Math.max(0, Math.round(pct)));
  const level = usageLevel(bounded);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={`usage-donut usage-donut--${level}`} title={title}>
      <svg className="usage-donut__svg" viewBox="0 0 22 22" aria-hidden="true">
        <circle className="usage-donut__bg" cx="11" cy="11" r={radius} />
        <circle
          className="usage-donut__val"
          cx="11"
          cy="11"
          r={radius}
          strokeDasharray={`${(bounded / 100) * circumference} ${circumference}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span className="usage-donut__label">{label}</span>
      <span className="usage-donut__text">{text ?? `${bounded}%`}</span>
    </div>
  );
}
