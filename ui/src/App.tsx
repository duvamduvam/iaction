import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AgentPage, type AgentPageHandle } from "./AgentPage";
import type { ChatPageHandle } from "./ChatPage";
import { CommandPalette } from "./CommandPalette";
// Les cinq autres pages n'arrivent qu'à leur première visite, et ne repartent
// jamais ensuite — voir pagesParesseuses.tsx (T-029).
import { ChatPage, OrchestrationPage, ProvidersPage, SlotPage, SupervisionPage, SystemPage } from "./pagesParesseuses";
import {
  COMPACT_BUTTON_MIN_TOKENS,
  COMPACT_BUTTON_RATIO,
  contextWindowFor,
  formatTokens,
  readCompactHandler,
  readContext,
  subscribeContext,
  type ContextSource,
} from "./contextBus";
import { initRoutingPush } from "./routerAdmin";
import { tachesList, tachesReports } from "./tachesClient";
import { openTerminal, systemStats, type SystemStats } from "./systemClient";
import { useProjects } from "./useProjects";
import { useProviders } from "./useProviders";
import { useSpeech } from "./useSpeech";
import { Donut } from "./Donut";
import { NAV_ITEMS, type PageId } from "./navigation";
import { handleFocusCycleKey, handleZoneArrowKey } from "./focusZones";
import { BandeauCoquilleMuette, SidecarMortBanner } from "./bandeaux";
import { Nav, ouvrirNouvelleFenetre } from "./barreNavigation";
import { basculerTousPanneaux } from "./panneauxLateraux";
import { UsageWidget } from "./encartConso";

/* ---------- Sonde système (CPU / RAM / GPU) ---------- */

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
function SystemStatsWidget() {
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
  // T-094 — une pastille PAR ORGANE (processeur, mémoire, carte graphique),
  // chacune avec sa charge et sa température. Cinq à six anneaux dans un seul
  // cadre se lisaient comme une bande indifférenciée : il fallait relire les
  // étiquettes pour savoir laquelle chauffait. Un groupe sans aucune sonde
  // n'est pas rendu — un cadre vide dirait « rien à signaler » là où il n'y a
  // rien à dire.
  const gpuPresent = stats.gpuPct !== null || stats.gpuTempC !== null;
  // T-129 — le GPU peut ne plus répondre (pilote qui a bougé sans redémarrage,
  // carte occupée…) sans pour autant être ABSENT du poste : `gpuIndisponible`
  // porte alors la cause verbatim de `nvidia-smi`. Sans pastille, le groupe
  // disparaissait purement et simplement, sans que l'utilisateur puisse
  // savoir pourquoi depuis l'application. Une seule pastille d'alerte, pas de
  // bandeau : elle s'intègre au même cadre que les mesures qu'elle remplace.
  const gpuMuet = !gpuPresent && stats.gpuIndisponible !== null;
  return (
    <div className="system-stats" title="Utilisation machine (rafraîchie toutes les 5 s)">
      {(stats.cpuPct !== null || stats.cpuTempC !== null) && (
        <div className="system-stats__organe system-stats__organe--cpu">
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
        </div>
      )}
      <div className="system-stats__organe system-stats__organe--ram">
        <Donut label="RAM" pct={ramPct} title={`Mémoire : ${ramDetail}`} />
        {stats.ramTempC !== null && (
          <Donut
            label="T.RAM"
            pct={tempPct(stats.ramTempC)}
            text={`${Math.round(stats.ramTempC)}°`}
            title={`Température mémoire : ${Math.round(stats.ramTempC)} °C`}
          />
        )}
      </div>
      {(gpuPresent || gpuMuet) && (
        <div className="system-stats__organe system-stats__organe--gpu">
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
          {gpuMuet && (
            <Donut
              label="GPU"
              pct={100}
              text="!"
              title={`GPU non mesuré : ${stats.gpuIndisponible}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Encart contexte ---------- */

/**
 * Contexte consommé par le fil de la page visible, en camembert comme les
 * autres encarts : « Contexte 34 k/200 k ». `source` désigne la page affichée
 * (voir contextBus.ts) — `null` sur les pages sans conversation, l'encart
 * disparaît alors plutôt que d'afficher un chiffre périmé.
 */
function ContextWidget({ source }: Readonly<{ source: ContextSource | null }>) {
  const [info, setInfo] = useState(() => (source ? readContext(source) : null));
  // Action « Compacter » enregistrée par la page visible (null = indisponible).
  const [onCompact, setOnCompact] = useState(() => (source ? readCompactHandler(source) : null));

  useEffect(() => {
    setInfo(source ? readContext(source) : null);
    setOnCompact(() => (source ? readCompactHandler(source) : null));
    if (!source) return;
    return subscribeContext(() => {
      setInfo(readContext(source));
      setOnCompact(() => readCompactHandler(source));
    });
  }, [source]);

  if (!info) return null;
  const max = contextWindowFor(info.model, info.usedTokens);
  const used = formatTokens(info.usedTokens);
  // Fenêtre inconnue (modèle hors table) : on montre les tokens consommés
  // sans inventer de pourcentage.
  if (max === null) {
    return (
      <div className="context-widget" title={`Contexte : ${info.usedTokens} tokens · fenêtre du modèle inconnue`}>
        <span className="usage-donut usage-donut--ok">
          <span className="usage-donut__label">Contexte</span>
          <span className="usage-donut__text">{used}</span>
        </span>
      </div>
    );
  }
  const pct = (info.usedTokens / max) * 100;
  return (
    <div className="context-widget">
      <Donut
        label="Contexte"
        pct={pct}
        text={`${Math.round(pct)}% · ${used}/${formatTokens(max)}`}
        title={`Contexte : ${info.usedTokens} tokens sur ${max} (${info.model})`}
      />
      {/* Contexte élevé : proposer la compaction du fil courant (l'action vit
          dans la page — Projets : « /compact » au CLI ; Chat : recompaction R4). */}
      {(pct >= COMPACT_BUTTON_RATIO * 100 || info.usedTokens >= COMPACT_BUTTON_MIN_TOKENS) && onCompact && (
        <button
          type="button"
          className="context-widget__compact"
          onClick={onCompact}
          title="Contexte élevé — compacter le fil : l'historique ancien est résumé, la conversation continue avec un contexte réduit"
        >
          Compacter
        </button>
      )}
    </div>
  );
}

/** Page visible → fil dont l'encart contexte parle (`null` = aucun). */
function contextSourceFor(page: PageId): ContextSource | null {
  if (page === "projects") return "agent";
  if (page === "chat") return "chat";
  return null;
}

/* ---------- Navigation ---------- */

/** Clé localStorage : mtime du dernier rapport de tâche « vu » (l'ouverture d'Orchestration marque vu). */
const TACHE_REPORTS_SEEN_KEY = "iastudio.tacheReportsSeenMs";

/*
 * En-tête + navigation principale : la barre d'onglets (Projets/Chat/
 * Configuration/Système) est intégrée à l'en-tête (rangée sous la marque),
 * plutôt qu'une colonne latérale verticale — libère toute la largeur pour le
 * contenu (voir App.css § En-tête / Navigation horizontale).
 */
function Header({
  page,
  onSelectPage,
  onOpenTerminal,
  orchestrationAlert,
}: Readonly<{
  page: PageId;
  onSelectPage: (id: PageId) => void;
  onOpenTerminal: () => void;
  orchestrationAlert: string | null;
}>) {
  return (
    <header className="app-header">
      <div className="app-header__top">
        <div className="brand">
          <div className="brand__title">
            IA <em>STUDIO</em>
            {/* Injectée à la compilation (ui/vite.config.ts) : pas d'attente,
                pas d'état d'échec à dessiner, et la même valeur qu'affiche
                l'installeur. */}
            <span className="brand__version" title={`IAction ${__VERSION_APPLICATION__}`}>
              v{__VERSION_APPLICATION__}
            </span>
          </div>
          <div className="brand__subtitle">Chat multi-fournisseur</div>
        </div>
        <div className="app-header__right">
          <ContextWidget source={contextSourceFor(page)} />
          <SystemStatsWidget />
          <UsageWidget />
        </div>
      </div>
      <Nav active={page} onSelect={onSelectPage} onOpenTerminal={onOpenTerminal} orchestrationAlert={orchestrationAlert} />
    </header>
  );
}

/* ---------- App ---------- */

function App() {
  const [page, setPage] = useState<PageId>("projects");
  // Pastille « nouveau rapport de tâche » sur l'onglet Orchestration (c'est là
  // que vivent les tâches et leur lecteur de rapports) : sonde légère (liste
  // des tâches + mtime des rapports, toutes les 60 s), comparée au dernier
  // « vu » (localStorage). Ouvrir Orchestration marque vu.
  const [tacheAlert, setTacheAlert] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function checkTacheReports() {
      try {
        const taches = await tachesList();
        let latestMs = 0;
        let latestLabel = "";
        for (const t of taches) {
          const reports = await tachesReports(t.name).catch(() => []);
          for (const r of reports) {
            if (r.mtimeMs > latestMs) {
              latestMs = r.mtimeMs;
              latestLabel = `${t.name} · ${r.file}`;
            }
          }
        }
        const seenMs = Number(localStorage.getItem(TACHE_REPORTS_SEEN_KEY) ?? "0");
        if (!cancelled) setTacheAlert(latestMs > seenMs ? latestLabel : null);
      } catch {
        // sidecar pas prêt / erreur passagère : pas de pastille, on retentera.
      }
    }
    void checkTacheReports();
    const interval = setInterval(() => void checkTacheReports(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (page === "orchestration" && tacheAlert !== null) {
      localStorage.setItem(TACHE_REPORTS_SEEN_KEY, String(Date.now()));
      setTacheAlert(null);
    }
  }, [page, tacheAlert]);
  const providerAdmin = useProviders();
  const projectAdmin = useProjects();
  // R1 — push de la table de routage (« model: auto ») au sidecar, accroché
  // au signal « providers poussés » : même cycle de vie que la table des
  // fournisseurs (démarrage, ready du sidecar, modifications dans l'admin).
  useEffect(() => initRoutingPush(), []);
  // Config voix (dictée/synthèse) : poussée au sidecar au démarrage et à
  // chaque changement, même cycle de vie que les fournisseurs.
  const speechAdmin = useSpeech();
  // Bascule imperative depuis la palette Ctrl+Maj+P — voir le commentaire
  // d'architecture en tête de CommandPalette.tsx : AgentPage garde la
  // propriété du projet sélectionné, App ne détient qu'un `ref` pour lui
  // demander une bascule (et savoir si elle a été acceptée).
  const agentPageRef = useRef<AgentPageHandle>(null);
  // Même principe pour la page Chat (Ctrl+N/Ctrl+K, voir l'écouteur clavier
  // global ci-dessous) : ChatPage garde la pleine propriété de son état.
  const chatPageRef = useRef<ChatPageHandle>(null);
  // Ctrl+K est destructif : la touche mémorise seulement la page ciblée, le

  function handlePaletteSelectProject(id: string): boolean {
    const ok = agentPageRef.current?.requestSelectProject(id) ?? false;
    if (ok) setPage("projects");
    return ok;
  }

  function handleOpenTerminal() {
    // Vue Projets → terminal dans le projet en cours ; ailleurs → home.
    const projectPath = page === "projects" ? (agentPageRef.current?.getSelectedProjectPath() ?? null) : null;
    openTerminal(projectPath).catch(() => {
      /* aucun émulateur trouvé : rien à afficher de plus utile ici */
    });
  }

  /*
   * Raccourcis clavier globaux (liste complète : page « Raccourcis » de
   * Configuration, voir ProvidersPage.tsx) — UN SEUL écouteur `keydown` ici,
   * plutôt qu'un par page ; chaque page n'expose que l'action via son `ref`
   * impératif (même patron que la palette de projets ci-dessus).
   *
   * Focus dans un champ de saisie : Ctrl+P/Ctrl+H restent actifs (simple
   * navigation, sans risque) ; Ctrl+N/Ctrl+K aussi — les bloquer pendant la
   * frappe d'un message serait frustrant — donc aucun garde de focus n'est
   * nécessaire pour ces 4 raccourcis. Ce qui reste bloquant : un streaming en
   * cours — `newSession`/`clearConversation` (AgentPageHandle/ChatPageHandle)
   * s'y refusent déjà d'eux-mêmes (silencieux, comme les boutons
   * correspondants), et `isStreaming` sert de garde ici même AVANT d'ouvrir
   * la confirmation de Ctrl+K (sinon une modale s'afficherait pour rien).
   *
   * `preventDefault` est systématique : Ctrl+P déclencherait sinon
   * l'impression, Ctrl+N une nouvelle fenêtre côté webview, Ctrl+H/Ctrl+K des
   * raccourcis navigateur (historique / barre de recherche).
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // F6 / Shift+F6 : cycle de focus entre les grandes zones de la page
      // active (voir PAGE_ZONES et cycleFocusZone).
      if (handleFocusCycleKey(e, page)) return;

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();

      // Ctrl+Maj+P : palette de bascule de projet, gérée par son propre
      // écouteur (CommandPalette.tsx) — surtout ne pas AUSSI aller à Projets.
      if (key === "p" && e.shiftKey) return;

      if (key === "p") {
        e.preventDefault();
        setPage("projects");
        return;
      }
      if (key === "h") {
        e.preventDefault();
        setPage("chat");
        return;
      }
      // Ctrl+Maj+N : nouvelle FENÊTRE (T-062) — à distinguer de Ctrl+N, qui
      // ouvre une nouvelle conversation. Testé AVANT lui, sinon la présence de
      // Maj passerait inaperçue et créerait une session de plus.
      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        ouvrirNouvelleFenetre();
        return;
      }
      if (key === "n") {
        e.preventDefault();
        if (page === "projects") agentPageRef.current?.newSession();
        else if (page === "chat") chatPageRef.current?.newSession();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        handleOpenTerminal();
        return;
      }

      // Ctrl+L : replier / déployer les DEUX panneaux latéraux (voir
      // panneauxLateraux.tsx). Valable partout, même si seules les pages de
      // conversation en possèdent — l'état est mémorisé et les y attend.
      //
      // Ctrl+Maj+L : ramener le curseur dans la zone de saisie (sans effet
      // hors des pages de conversation, qui seules en possèdent une). Ce
      // raccourci tenait Ctrl+L jusqu'au 2026-08-20 ; il lui cède la place —
      // dégager l'écran est demandé bien plus souvent que reposer un curseur
      // que la page place déjà d'elle-même à l'arrivée, après un vidage et
      // après une nouvelle conversation.
      if (key === "l") {
        e.preventDefault();
        if (e.shiftKey) {
          if (page === "projects") agentPageRef.current?.focusComposer();
          else if (page === "chat") chatPageRef.current?.focusComposer();
        } else {
          basculerTousPanneaux();
        }
        return;
      }

      // Ctrl+1..6 : navigation directe entre les pages, sans souris. On lit
      // `e.code` (Numpad1 / Digit1) plutôt que `e.key` : sur le pavé
      // numérique, `key` vaut "End"/"ArrowDown"… quand le verrouillage
      // numérique est éteint, alors que `code` reste stable.
      const navMatch = /^(?:Numpad|Digit)([1-9])$/.exec(e.code);
      if (navMatch) {
        const index = Number(navMatch[1]) - 1;
        const target = NAV_ITEMS[index];
        if (target) {
          e.preventDefault();
          setPage(target.id);
        }
        return;
      }
      if (key === "k") {
        e.preventDefault();
        // Vidage immédiat, sans confirmation : la page affiche un bandeau
        // « Annuler » qui restaure la conversation (voir clearConversation).
        if (page === "projects") agentPageRef.current?.clearConversation();
        else if (page === "chat") chatPageRef.current?.clearConversation();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page]);

  /*
   * Alt+flèches (zone voisine) : écouteur DÉDIÉ, en phase de CAPTURE. Le
   * raccourci vaut jusque dans les champs de saisie et l'éditeur de code, or
   * ceux-ci ont leurs propres liaisons Alt+flèche — le keymap par défaut de
   * CodeMirror y met le déplacement de ligne (Alt+↑/↓) et le saut de nœud
   * syntaxique (Alt+←/→), et le webview peut lire Alt+←/→ comme
   * précédent/suivant dans l'historique. En bouillonnement, l'écouteur global
   * passerait APRÈS eux, trop tard. En capture il passe AVANT : quand le
   * déplacement a lieu, `preventDefault` + `stopPropagation` (voir
   * handleZoneArrowKey) empêchent l'événement de jamais leur parvenir. Sans
   * déplacement (aucune zone de ce côté, modale ouverte), rien n'est consommé
   * et la touche suit son cours normal.
   */
  useEffect(() => {
    function onKeyDownCapture(e: KeyboardEvent) {
      handleZoneArrowKey(e, page);
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [page]);

  // Arrivée sur une page de conversation : le curseur va directement dans le
  // composeur (on tape sans cliquer). Les pages restent montées en permanence
  // (slots masqués), d'où ce déclenchement au changement de `page` plutôt
  // qu'un `autoFocus` qui ne jouerait qu'au tout premier montage.
  useEffect(() => {
    if (page === "projects") agentPageRef.current?.focusComposer();
    else if (page === "chat") chatPageRef.current?.focusComposer();
  }, [page]);

  return (
    <div className="app-shell">
      <Header page={page} onSelectPage={setPage} onOpenTerminal={handleOpenTerminal} orchestrationAlert={tacheAlert} />
      <SidecarMortBanner />
      <BandeauCoquilleMuette />
      <main className="app-content">
        {/*
          Une page reste montée une fois visitée (masquée via CSS) pour ne pas
          perdre la conversation en cours ou les logs quand on change d'onglet.
          Ce qui est différé, c'est seulement sa PREMIÈRE mise en mémoire —
          voir pagesParesseuses.tsx.
        */}
        <SlotPage active={page === "projects"}>
          <AgentPage
            ref={agentPageRef}
            projects={projectAdmin.projects}
            projectsLoadState={projectAdmin.loadState}
            providers={providerAdmin.providers}
            onGoToConfig={() => setPage("config")}
            micDeviceId={speechAdmin.config.stt.inputDeviceId}
            conversationConfig={speechAdmin.config.conversation}
            pageVisible={page === "projects"}
          />
        </SlotPage>
        <SlotPage active={page === "chat"}>
          <ChatPage
            ref={chatPageRef}
            providers={providerAdmin.providers}
            micDeviceId={speechAdmin.config.stt.inputDeviceId}
            conversationConfig={speechAdmin.config.conversation}
            pageVisible={page === "chat"}
          />
        </SlotPage>
        <SlotPage active={page === "orchestration"}>
          <OrchestrationPage projects={projectAdmin.projects} providers={providerAdmin.providers} />
        </SlotPage>
        <SlotPage active={page === "supervision"}>
          <SupervisionPage />
        </SlotPage>
        <SlotPage active={page === "config"}>
          <ProvidersPage
            providers={providerAdmin.providers}
            keyStatus={providerAdmin.keyStatus}
            loadState={providerAdmin.loadState}
            errorMessage={providerAdmin.errorMessage}
            onSaveProvider={providerAdmin.saveProvider}
            onDeleteProvider={providerAdmin.deleteProvider}
            onSaveKey={providerAdmin.saveKey}
            onClearKey={providerAdmin.clearKey}
            projects={projectAdmin.projects}
            projectsLoadState={projectAdmin.loadState}
            projectsErrorMessage={projectAdmin.errorMessage}
            onAddProject={projectAdmin.addProject}
            onUpdateProject={projectAdmin.updateProject}
            onDeleteProject={projectAdmin.deleteProject}
            speechConfig={speechAdmin.config}
            speechKeyStatus={speechAdmin.keyStatus}
            speechKeyOrigin={speechAdmin.keyOrigin}
            speechErrorMessage={speechAdmin.errorMessage}
            onSaveSpeechConfig={speechAdmin.saveConfig}
            onSaveSpeechKey={speechAdmin.saveKey}
            onClearSpeechKey={speechAdmin.clearKey}
          />
        </SlotPage>
        <SlotPage active={page === "system"}>
          <SystemPage />
        </SlotPage>
      </main>
      <CommandPalette projects={projectAdmin.projects} onSelectProject={handlePaletteSelectProject} />
    </div>
  );
}

export default App;
