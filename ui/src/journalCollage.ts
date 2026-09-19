/*
 * Vocabulaire de journalisation du collage d'image via le repli natif
 * (presse-papier système, T-048 — voir docs/tickets.md et
 * src-tauri/src/clipboard.rs). Même pattern que journalVoix.ts : le canal,
 * le niveau et la forme des champs vivent ici, en un seul endroit, pour
 * qu'un collage ne finisse pas par produire une ligne différente selon
 * l'appelant.
 *
 * POURQUOI cette ligne : le ticket exigeait quatre segments horodatés avant
 * tout correctif (négociation du presse-papier, encodage PNG, encodage
 * base64 — trois causes possibles, trois correctifs différents) et
 * n'INTERDISAIT PAS de conclure, mais de conclure SANS mesure (cf. T-012,
 * T-019). Les deux jalons posés le 2026-08-15 étaient en `debug` — or
 * `IACTION_LOG_LEVEL` vaut `info` par défaut et `debug` n'est pas écrit
 * (docs/protocol.md, § « Forme d'une entrée ») : c'est très probablement
 * pourquoi zéro occurrence n'a été vue en un mois de journal, alors même que
 * l'instrumentation existait. Cette ligne est donc en `info` : nominale,
 * pas une panne (T-057 interdit de crier), mais écrite par défaut.
 *
 * Module PUR au sens du projet : sa seule dépendance est ./journal.
 */
import { logInfo } from "./journal";

/** Les quatre segments du ticket, une fois tous connus. */
export interface MesureCollageImage {
  /** Segment 1 — événement `paste` → vignette « en chargement » RÉELLEMENT peinte. */
  peintureMs: number;
  /** Segment 2 — `invoke` → retour de `clipboard_read_image` (le détail
   * `get_image()`/`encode_png` part séparément, côté Rust — voir clipboard.rs). */
  invokeMs: number;
  /** Segment 3 — taille et dimensions du PNG produit (`null` si l'en-tête PNG est illisible). */
  octets: number;
  largeur: number | null;
  hauteur: number | null;
  /** Segment 4 — `FileReader` → `dataUrl` posée, vignette pleine. */
  base64Ms: number;
}

/**
 * POINT DE JOURNAL T-048 — la ligne récapitulative d'UN collage d'image par
 * le repli natif, une fois les quatre segments connus. Une seule ligne par
 * collage : les segments intermédiaires ne sont PAS journalisés à part (voir
 * `collerImageDuPressePapierNatif`, Attachments.tsx).
 */
export function journalCollageImage(mesure: MesureCollageImage): void {
  logInfo("ui", "collage : image du presse-papier (repli natif)", {
    fields: {
      peintureMs: mesure.peintureMs,
      invokeMs: mesure.invokeMs,
      octets: mesure.octets,
      largeur: mesure.largeur,
      hauteur: mesure.hauteur,
      base64Ms: mesure.base64Ms,
    },
  });
}
