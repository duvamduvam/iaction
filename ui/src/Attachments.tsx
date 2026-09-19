/*
 * Pièces jointes du composeur de chat — partagé par AgentPage.tsx (moteur
 * Claude uniquement, voir contrat) et ChatPage.tsx (`chat.send` et
 * `claude.start` en mode chat pur). Contrat sidecar :
 * docs/protocol.md § « Pièces jointes (chat.send, claude.send) ».
 *
 * Trois familles d'éléments :
 * - `useAttachmentDraft` : état + validation (miroir UI des limites sidecar :
 *   8 pièces, 8 Mo/image, 2 Mo/texte) + lecture FileReader des fichiers
 *   ajoutés (bouton, collage, glisser-déposer) — un seul point d'entrée
 *   `addFiles`, appelé par chaque page depuis ses propres handlers
 *   onChange/onPaste/onDrop.
 * - `AttachmentPickerButton` / `AttachmentTray` : bouton 📎 + rangée de
 *   vignettes/chips affichée AU-DESSUS du textarea, avant envoi.
 * - `SentAttachments` : affichage dans la transcription, une fois le tour
 *   envoyé — vignette cliquable (→ modale plein cadre) pour les images tant
 *   que l'aperçu (data URL) vit encore en mémoire, chip pour les textes.
 *
 * Persistance (voir le contrat) : les octets ne sont JAMAIS écrits sur
 * disque. `SentAttachment.previewUrl` n'existe qu'en mémoire, pour la durée
 * de vie de l'onglet — chaque page doit appeler `toAttachmentRefs` juste
 * avant sérialisation (voir `buildPersistedSession`/`buildPersistedChatSession`)
 * pour ne garder que `{kind, name}`. Après un rechargement, `previewUrl` est
 * donc absent : `SentAttachments` retombe alors sur un simple chip
 * « pièce jointe : <nom> », sans vignette — comportement attendu, pas un bug.
 */
import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { dimensionsPng, readClipboardImage } from "./clipboardClient";
import { journalCollageImage } from "./journalCollage";
import { Modal } from "./Modal";
import type { ChatAttachment, ImageAttachmentMediaType } from "./sidecar";

/* ---------- Limites UI (miroir des limites sidecar, voir docs/protocol.md) ---------- */

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: readonly ImageAttachmentMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

// Extensions texte reconnues en plus des types MIME `text/*`/`application/json`
// (beaucoup de fichiers de code n'ont pas de MIME fiable côté navigateur).
const TEXT_EXTENSIONS = [
  ".md", ".txt", ".csv", ".json",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs",
  ".rb", ".php", ".sh", ".bash",
  ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".sql",
];

/** Valeur de l'attribut `accept` du sélecteur de fichiers (bouton 📎). */
export const ATTACHMENT_ACCEPT = [...IMAGE_MEDIA_TYPES, ...TEXT_EXTENSIONS].join(",");

function isImageMediaType(type: string): type is ImageAttachmentMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

function looksLikeText(file: File): boolean {
  if (file.type.startsWith("text/") || file.type === "application/json") return true;
  const lower = file.name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/* ---------- Modèle de données ---------- */

/** Pièce jointe dans le composeur, avant envoi — porte aperçu/taille pour l'affichage. */
export interface DraftAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  size: number;
  /** Image uniquement. */
  mediaType?: ImageAttachmentMediaType;
  /** Image uniquement : `data:<mediaType>;base64,<b64>` (aperçu + source de l'envoi). */
  dataUrl?: string;
  /**
   * Image collée : URL d'objet (`blob:`) pour l'AFFICHAGE seul (T-048).
   *
   * Créée sans copie ni encodage, donc disponible à l'instant où les octets
   * arrivent — là où la data URL demande de relire tout le PNG en base64
   * (+33 % d'octets) avant de pouvoir peindre quoi que ce soit. L'envoi, lui,
   * continue d'exiger `dataUrl` : c'est le contrat du sidecar, et la pièce
   * reste `loading` tant qu'il n'est pas honoré.
   */
  apercuUrl?: string;
  /** Texte uniquement : contenu brut. */
  content?: string;
  /**
   * Image collée via le presse-papier NATIF (repli WebKitGTK) : la vignette
   * s'affiche aussitôt en « chargement », puis `dataUrl`/`size` sont remplis en
   * arrière-plan et `loading` repasse à `false`. L'envoi est bloqué tant qu'une
   * pièce reste en chargement (voir les pages).
   */
  loading?: boolean;
}

/**
 * Pièce jointe telle qu'affichée dans la transcription. `previewUrl` (data
 * URL) n'existe qu'en mémoire, le temps de la session d'app — voir le
 * commentaire d'en-tête. Sert AUSSI de forme persistée (une fois `previewUrl`
 * omis par `toAttachmentRefs`), pour ne pas dupliquer un type quasi identique.
 */
export interface SentAttachment {
  kind: "image" | "text";
  name: string;
  previewUrl?: string;
}

let draftCounter = 0;
function nextDraftId(): string {
  draftCounter += 1;
  return `att-${draftCounter}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture impossible"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture impossible"));
    reader.readAsText(file);
  });
}

/** Un fichier → `DraftAttachment`, ou une erreur française lisible (limite dépassée/type non pris en charge). */
async function fileToDraft(file: File): Promise<{ draft: DraftAttachment | null; error: string | null }> {
  if (isImageMediaType(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { draft: null, error: `« ${file.name} » dépasse 8 Mo (image).` };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      draft: { id: nextDraftId(), kind: "image", name: file.name, size: file.size, mediaType: file.type as ImageAttachmentMediaType, dataUrl },
      error: null,
    };
  }
  if (looksLikeText(file)) {
    if (file.size > MAX_TEXT_BYTES) {
      return { draft: null, error: `« ${file.name} » dépasse 2 Mo (texte).` };
    }
    const content = await readAsText(file);
    return { draft: { id: nextDraftId(), kind: "text", name: file.name, size: file.size, content }, error: null };
  }
  return { draft: null, error: `« ${file.name} » : type non pris en charge.` };
}

/** État + logique du composeur de pièces jointes — un seul hook, réutilisé par AgentPage.tsx/ChatPage.tsx. */
export function useAttachmentDraft() {
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>([]);
  // Miroir synchrone (même pattern que turnsRef/entriesRef dans les deux
  // pages) : `addFiles` a besoin de la longueur COURANTE pour appliquer la
  // limite de 8 pièces sans attendre le prochain rendu.
  const attachmentsRef = useRef<DraftAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const applyAttachments = useCallback((updater: (prev: DraftAttachment[]) => DraftAttachment[]) => {
    setAttachmentsState((prev) => {
      const next = updater(prev);
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
      if (room <= 0) {
        setError("8 pièces jointes maximum par message.");
        return;
      }
      const accepted = list.slice(0, room);
      const overflow = list.length - accepted.length;
      void (async () => {
        const drafts: DraftAttachment[] = [];
        const errors: string[] = [];
        for (const file of accepted) {
          try {
            const { draft, error: fileError } = await fileToDraft(file);
            if (draft) drafts.push(draft);
            else if (fileError) errors.push(fileError);
          } catch {
            errors.push(`« ${file.name} » : lecture impossible.`);
          }
        }
        if (overflow > 0) errors.push(`8 pièces jointes maximum par message — ${overflow} fichier(s) ignoré(s).`);
        if (drafts.length > 0) applyAttachments((prev) => [...prev, ...drafts]);
        setError(errors.length > 0 ? errors.join(" ") : null);
      })();
    },
    [applyAttachments],
  );

  const removeAttachment = useCallback(
    (id: string) =>
      applyAttachments((prev) => {
        // L'URL d'objet d'une image collée (T-048) référence son tampon tant
        // qu'elle n'est pas révoquée. Ici — retrait EXPLICITE — la pièce ne
        // reviendra pas ; `clear()` n'en fait rien, lui, parce que `restore()`
        // repose les mêmes objets après un envoi qui a échoué, vignettes
        // comprises.
        const partante = prev.find((a) => a.id === id);
        if (partante?.apercuUrl) URL.revokeObjectURL(partante.apercuUrl);
        return prev.filter((a) => a.id !== id);
      }),
    [applyAttachments],
  );

  const clear = useCallback(() => {
    applyAttachments(() => []);
    setError(null);
  }, [applyAttachments]);

  /**
   * Repose des pièces jointes dans le composeur — utilisé quand un tour ÉCHOUE
   * après un envoi : le tiroir est vidé dès l'envoi (sinon les vignettes
   * traînent pendant tout le tour alors qu'elles sont déjà parties), mais un
   * échec ne doit pas obliger à tout rejoindre. Ne remplace jamais ce que
   * l'utilisateur a pu ajouter entre-temps : les nouvelles pièces restent
   * devant, dans la limite habituelle.
   */
  const restore = useCallback(
    (items: DraftAttachment[]) => {
      if (items.length === 0) return;
      applyAttachments((prev) => {
        const known = new Set(prev.map((a) => a.id));
        const back = items.filter((a) => !known.has(a.id));
        return [...prev, ...back].slice(0, MAX_ATTACHMENTS);
      });
    },
    [applyAttachments],
  );

  /**
   * Insère une vignette d'image « en chargement » IMMÉDIATEMENT (retour
   * synchrone d'un id), avant même d'avoir les octets — pour un retour visuel
   * instantané au collage d'une capture (le presse-papier natif, lu ensuite,
   * peut prendre un instant). Renvoie `null` (et signale l'erreur) s'il n'y a
   * plus de place. À compléter par `resolveImage(id, …)`.
   */
  const beginImage = useCallback(
    (name: string): string | null => {
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
        setError("8 pièces jointes maximum par message.");
        return null;
      }
      const id = nextDraftId();
      applyAttachments((prev) => [
        ...prev,
        { id, kind: "image", name, size: 0, mediaType: "image/png", loading: true },
      ]);
      return id;
    },
    [applyAttachments],
  );

  /**
   * Complète (ou retire) la vignette créée par `beginImage`. `bytes === null` :
   * finalement pas d'image (le placeholder est retiré sans bruit). Sinon on
   * encode le PNG en data URL en ARRIÈRE-PLAN (`FileReader`), puis on remplit
   * `dataUrl`/`size` et on lève `loading`.
   *
   * Renvoie `octets`/`base64Ms` (segment 4 du ticket T-048) une fois la data
   * URL posée, ou `null` si l'appelant n'a rien à en tirer (pas d'image,
   * limite dépassée, lecture en échec) — c'est ce que
   * `collerImageDuPressePapierNatif` réunit avec les segments précédents en
   * UNE ligne de journal, sans dupliquer la lecture du même tampon.
   */
  const resolveImage = useCallback(
    (id: string, bytes: Uint8Array | null): Promise<{ octets: number; base64Ms: number } | null> => {
      if (!bytes) {
        applyAttachments((prev) => prev.filter((a) => a.id !== id));
        return Promise.resolve(null);
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        applyAttachments((prev) => prev.filter((a) => a.id !== id));
        setError("Image collée : dépasse 8 Mo.");
        return Promise.resolve(null);
      }
      // T-048 — l'aperçu D'ABORD, sans rien encoder : `createObjectURL` ne
      // fait que publier une référence au tampon déjà en mémoire. La vignette
      // peut donc être peinte au prochain rendu, sans attendre la base64.
      const blob = new Blob([bytes], { type: "image/png" });
      const apercuUrl = URL.createObjectURL(blob);
      applyAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, apercuUrl, size: bytes.byteLength } : a)),
      );

      // `loading` ne retombe qu'avec la data URL, et c'est délibéré : elle est
      // la SOURCE DE L'ENVOI (contrat du sidecar). Lever le drapeau plus tôt
      // autoriserait à envoyer une image vide — une vignette visible ne prouve
      // que l'affichage.
      const debutBase64 = performance.now();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result);
          const base64Ms = Math.round(performance.now() - debutBase64);
          applyAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, dataUrl, size: bytes.byteLength, loading: false } : a)),
          );
          resolve({ octets: bytes.byteLength, base64Ms });
        };
        reader.onerror = () => {
          URL.revokeObjectURL(apercuUrl);
          applyAttachments((prev) => prev.filter((a) => a.id !== id));
          setError("Image collée : lecture impossible.");
          resolve(null);
        };
        reader.readAsDataURL(blob);
      });
    },
    [applyAttachments],
  );

  return { attachments, addFiles, beginImage, resolveImage, removeAttachment, clear, restore, error, setError };
}

/**
 * Repli natif du collage (T-048) : vignette immédiate (`beginImage`), lecture
 * du presse-papier natif (`readClipboardImage`), puis remplissage
 * (`resolveImage`) — INSTRUMENTÉ pour produire les quatre segments que le
 * ticket demandait de mesurer avant tout correctif, réunis en UNE ligne de
 * journal (`journalCollageImage`). Seul point d'entrée du repli, appelé
 * IDENTIQUEMENT par AgentPage.tsx et ChatPage.tsx : le mécanisme de mesure
 * n'a aucune raison de vivre dans les pages, déjà au ras de leur plafond de
 * taille (`scripts/cliquet-taille.json`).
 *
 * Aucun changement de comportement : mêmes appels, dans le même ordre, avec
 * les mêmes issues (vignette retirée si `bytes` est `null`) — seule la
 * mesure est nouvelle. `beginImage`/`resolveImage` sont pris en paramètres
 * (et non importés) pour rester ceux de l'instance React appelante.
 */
export function collerImageDuPressePapierNatif(
  beginImage: (name: string) => string | null,
  resolveImage: (id: string, bytes: Uint8Array | null) => Promise<{ octets: number; base64Ms: number } | null>,
): void {
  const debutCollage = performance.now();
  const placeholderId = beginImage("capture-collée.png");
  if (!placeholderId) return; // plus de place — rien à lire ni à mesurer

  // Segment 1 — le seul des quatre qui mesure une PEINTURE et non un simple
  // retour de fonction. Deux `requestAnimationFrame` imbriqués, posés juste
  // après le rendu déclenché par `beginImage` : le premier callback tourne
  // une fois la frame courante traitée par le navigateur, le second attend
  // la frame SUIVANTE — empiriquement le moment où le tampon précédent a été
  // peint. Limite assumée : ceci ne PROUVE pas que les pixels ont atteint
  // l'écran physique (la latence du compositeur/pilote graphique reste hors
  // de portée du DOM), mais c'est la meilleure approximation accessible
  // depuis l'UI, et sans commune mesure avec un `setState` qui ne dit rien
  // de l'affichage.
  const peinture = new Promise<number>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(Math.round(performance.now() - debutCollage)));
    });
  });

  const debutInvoke = performance.now();
  void readClipboardImage()
    .then(async (bytes) => {
      // Segment 2 — aller-retour complet de la commande (négociation du
      // presse-papier + encodage PNG natif) ; le détail des deux parties
      // n'est chronométrable QUE côté Rust et part séparément, même
      // commande, scope `rust` (voir clipboard.rs).
      const invokeMs = Math.round(performance.now() - debutInvoke);
      const suite = await resolveImage(placeholderId, bytes);
      if (!bytes || !suite) return; // pas d'image, ou lecture en échec : rien à récapituler
      const dims = dimensionsPng(bytes); // segment 3
      const peintureMs = await peinture;
      journalCollageImage({
        peintureMs,
        invokeMs,
        octets: suite.octets,
        largeur: dims?.largeur ?? null,
        hauteur: dims?.hauteur ?? null,
        base64Ms: suite.base64Ms, // segment 4
      });
    })
    .catch(() => {
      void resolveImage(placeholderId, null);
    });
}

/* ---------- Conversion vers le contrat sidecar / vers la transcription ---------- */

function extractBase64(dataUrl: string | undefined): string {
  if (!dataUrl) return "";
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/** `DraftAttachment[]` → `attachments` du contrat (`chat.send`/`claude.start`) — base64 SANS préfixe. */
export function toContractAttachments(drafts: DraftAttachment[]): ChatAttachment[] {
  return drafts.map((d) =>
    d.kind === "image"
      ? { kind: "image" as const, name: d.name, mediaType: (d.mediaType ?? "image/png") as ImageAttachmentMediaType, data: extractBase64(d.dataUrl) }
      : { kind: "text" as const, name: d.name, content: d.content ?? "" },
  );
}

/** `DraftAttachment[]` → pièces à accrocher au tour ENVOYÉ (avec aperçu, encore en mémoire). */
export function toSentAttachments(drafts: DraftAttachment[]): SentAttachment[] {
  return drafts.map((d) => ({ kind: d.kind, name: d.name, previewUrl: d.kind === "image" ? d.dataUrl : undefined }));
}

/**
 * Forme à écrire dans un tour/une entrée PERSISTÉE : ne garde que
 * `{kind, name}` (jamais les octets, voir le contrat). `undefined` si rien à
 * persister, pour que le champ disparaisse proprement du JSON écrit.
 */
export function toAttachmentRefs(items: SentAttachment[] | undefined): SentAttachment[] | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map(({ kind, name }) => ({ kind, name }));
}

/* ---------- Extraction de fichiers depuis le presse-papier / le glisser-déposer ---------- */

/** Images du presse-papier (Ctrl+V) — c'est la demande utilisateur clef. */
/**
 * Images présentes dans le presse-papier. Deux sources lues, car aucune n'est
 * fiable partout : `items` (Chromium et la plupart des cas WebKit) ET
 * `files` (WebKitGTK — le moteur de Tauri sous Linux — ne remplit parfois que
 * celui-là pour une capture d'écran). Dédoublonnage par nom+taille.
 */
export function filesFromClipboard(e: ReactClipboardEvent): File[] {
  const data = e.clipboardData;
  if (!data) return [];
  const found: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) found.push(file);
    }
  }
  for (const file of data.files ?? []) {
    if (file.type.startsWith("image/")) found.push(file);
  }
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.name}:${f.size}:${f.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Vrai si le presse-papier contient au moins une image (sans la lire). */
export function clipboardHasImage(e: ReactClipboardEvent): boolean {
  const data = e.clipboardData;
  if (!data) return false;
  for (const item of data.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  for (const file of data.files ?? []) {
    if (file.type.startsWith("image/")) return true;
  }
  return false;
}

export function filesFromDrop(e: ReactDragEvent): File[] {
  return Array.from(e.dataTransfer?.files ?? []);
}


/* ---------- Composeur : bouton + rangée de vignettes/chips ---------- */

export function AttachmentPickerButton({
  onFiles,
  disabled,
  title,
}: Readonly<{ onFiles: (files: FileList) => void; disabled?: boolean; title?: string }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost attachment-picker"
        title={title ?? "Joindre des fichiers"}
        aria-label="Joindre des fichiers"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        📎
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="attachment-picker__input"
        onChange={(e) => {
          if (e.currentTarget.files && e.currentTarget.files.length > 0) onFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </>
  );
}

function AttachmentChip({ item, onRemove }: Readonly<{ item: DraftAttachment; onRemove: () => void }>) {
  return (
    <div className="attachment-chip">
      {item.kind === "image" && (item.apercuUrl ?? item.dataUrl) ? (
        <img className="attachment-chip__thumb" src={item.apercuUrl ?? item.dataUrl} alt={item.name} />
      ) : item.loading ? (
        <span
          className="attachment-chip__thumb attachment-chip__thumb--loading"
          role="img"
          aria-label="Chargement de l'image…"
        />
      ) : (
        <span className="attachment-chip__icon" aria-hidden="true">📄</span>
      )}
      <span className="attachment-chip__meta">
        <span className="attachment-chip__name" title={item.name}>{item.name}</span>
        <span className="attachment-chip__size">{item.loading ? "…" : formatSize(item.size)}</span>
      </span>
      <button type="button" className="attachment-chip__remove" aria-label={`Retirer ${item.name}`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

/** Rangée de vignettes/chips au-dessus du textarea, avant envoi. */
export function AttachmentTray({ items, onRemove }: Readonly<{ items: DraftAttachment[]; onRemove: (id: string) => void }>) {
  if (items.length === 0) return null;
  return (
    <div className="attachment-tray">
      {items.map((item) => (
        <AttachmentChip key={item.id} item={item} onRemove={() => onRemove(item.id)} />
      ))}
    </div>
  );
}

/* ---------- Transcription : vignette cliquable + modale plein cadre ---------- */

function ImageLightbox({ src, name, onClose }: Readonly<{ src: string; name: string; onClose: () => void }>) {
  return (
    <Modal label={name} onClose={onClose}>
      <div className="attachment-lightbox">
        <img src={src} alt={name} />
        <button type="button" className="attachment-lightbox__close" aria-label="Fermer" onClick={onClose}>
          ×
        </button>
      </div>
    </Modal>
  );
}

/** Pièces jointes d'un tour déjà envoyé — vignette cliquable (image, aperçu encore en mémoire) ou chip (texte, ou image relue du disque sans aperçu). */
export function SentAttachments({ items }: Readonly<{ items: SentAttachment[] }>) {
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="attachment-tray attachment-tray--sent">
      {items.map((item, i) =>
        item.previewUrl ? (
          <button
            // Clé = index assumée (voir commentaire) — règle react/no-array-index-key non chargée ici.
            key={i}
            type="button"
            className="attachment-chip attachment-chip--button"
            onClick={() => setLightbox({ src: item.previewUrl as string, name: item.name })}
          >
            <img className="attachment-chip__thumb" src={item.previewUrl} alt={item.name} />
            <span className="attachment-chip__name" title={item.name}>{item.name}</span>
          </button>
        ) : (
          // Clé = index assumée (voir commentaire) — règle react/no-array-index-key non chargée ici.
          <span key={i} className="attachment-chip attachment-chip--ref" title={item.name}>
            <span className="attachment-chip__icon" aria-hidden="true">{item.kind === "image" ? "🖼" : "📄"}</span>
            <span className="attachment-chip__name">pièce jointe : {item.name}</span>
          </span>
        ),
      )}
      {lightbox && <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />}
    </div>
  );
}
