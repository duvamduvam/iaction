/*
 * T-148 — menu « Micro / Sortie » du composeur, ouvert par le chevron ▾ placé
 * sous les boutons 🎤 et 🗣 (rendu par `VoiceButtons`, donc hérité par les pages
 * Chat et Projets sans qu'aucune n'y touche).
 *
 * Déclencheur : un casque Bluetooth n'était pas capté parce que l'app prenait le
 * micro par défaut du système (le micro interne, coupé), et le seul réglage
 * vivait enfoui dans Configuration › Voix. Le clic sur 🎤/🗣 ne change pas : il
 * démarre tout de suite avec le dernier choix mémorisé ; ce menu sert à CHANGER.
 *
 * - Micro, comme la sortie : ENTRÉE par défaut du SYSTÈME, via la coquille (Linux).
 *   Décision du 2026-10-05, après essai : un micro web mémorisé primait sur le
 *   défaut du système et se perdait dès qu'un casque se reconnectait. Choisir une
 *   entrée remet donc `stt.inputDeviceId` à « défaut » (par le bus de
 *   `busMicro.ts`), sans quoi le choix serait sans effet. Si la coquille ne prend
 *   pas la chose en charge (Windows, macOS), on garde le comportement d'avant :
 *   liste `enumerateDevices` enregistrée dans `stt.inputDeviceId`.
 * - Sortie : sortie par défaut du SYSTÈME, via la coquille (Linux seulement ; la
 *   section est absente ailleurs). Elle bascule le son de tout le poste, pas
 *   seulement celui de l'app — c'est dit dans le libellé.
 *
 * Rendu dans `document.body` (portail) en position fixe, comme `ModelPicker` :
 * la colonne d'outils du composeur est étroite et peut rogner un menu absolu.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { listMicrophones, type MicrophoneDevice } from "./audioCapture";
import { choisirEntreeAudio, choisirSortieAudio, listerEntreesAudio, listerSortiesAudio } from "./audioSortiesClient";
import { abonnerMicroCourant, demanderPatchConfigVoix, lireMicroCourant } from "./busMicro";
import { toMessage } from "./base";
import {
  journalChoixEntreeSysteme,
  journalChoixMicro,
  journalPanneChoixEntree,
  journalPanneChoixMicro,
  journalPanneChoixSortie,
  journalPanneListeEntrees,
  journalPanneListeSorties,
} from "./journalVoix";
import { construireEntreesMicro, libelleAvecEtat, type ListePeripheriques } from "./peripheriquesAudio";

const LARGEUR_MENU = 320;
const HAUTEUR_MAX_MENU = 420;

interface Position {
  left: number;
  top?: number;
  bottom?: number;
}

/** Ancre le menu sur le bouton : vers le haut s'il n'y a pas la place dessous (composeur en bas de page). */
function calculerPosition(bouton: HTMLElement): Position {
  const rect = bouton.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - LARGEUR_MENU - 8));
  const placeEnDessous = window.innerHeight - rect.bottom;
  return placeEnDessous >= HAUTEUR_MAX_MENU || placeEnDessous >= rect.top
    ? { left, top: rect.bottom + 4 }
    : { left, bottom: window.innerHeight - rect.top + 4 };
}

/**
 * `desactive` : micro ouvert (dictée ou conversation) — le choix ne s'appliquerait
 * qu'à la prochaine écoute, on évite de laisser croire qu'il agit tout de suite.
 */
export function MenuPeripheriquesAudio({ desactive }: Readonly<{ desactive: boolean }>) {
  const [ouvert, setOuvert] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [micros, setMicros] = useState<MicrophoneDevice[]>([]);
  const [sorties, setSorties] = useState<ListePeripheriques | null>(null);
  const [entrees, setEntrees] = useState<ListePeripheriques | null>(null);
  // Lecture des entrées système en échec : on retombe sur les micros web plutôt que de
  // laisser la section vide (l'erreur, elle, est affichée et journalisée).
  const [entreesEchec, setEntreesEchec] = useState(false);
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);
  const boutonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const microCourant = useSyncExternalStore(abonnerMicroCourant, lireMicroCourant);

  const relireSorties = useCallback(async () => {
    try {
      setSorties(await listerSortiesAudio());
    } catch (err) {
      const message = toMessage(err);
      journalPanneListeSorties(message);
      setErreur(`Sorties audio illisibles : ${message}`);
    }
  }, []);

  const relireEntrees = useCallback(async () => {
    try {
      setEntrees(await listerEntreesAudio());
      setEntreesEchec(false);
    } catch (err) {
      const message = toMessage(err);
      journalPanneListeEntrees(message);
      setEntreesEchec(true);
      setErreur(`Entrées audio illisibles : ${message}`);
    }
  }, []);

  // Fermeture forcée si le micro s'ouvre pendant que le menu est ouvert.
  useEffect(() => {
    if (desactive) setOuvert(false);
  }, [desactive]);

  // Tant que le menu est ouvert : listes rafraîchies à l'ouverture et à chaque
  // `devicechange` (un casque qui se connecte), fermeture sur Échap et clic extérieur.
  useEffect(() => {
    if (!ouvert) return;
    let vivant = true;
    const relireMicros = () => {
      listMicrophones()
        .then((devices) => {
          if (vivant) setMicros(devices);
        })
        .catch(() => {
          /* énumération indisponible : le menu se limite au défaut système et au choix mémorisé */
        });
    };
    relireMicros();
    void relireSorties();
    void relireEntrees();
    // Un casque qui se connecte change aussi les entrées DU SYSTÈME, pas seulement les web.
    const surChangement = () => {
      relireMicros();
      void relireEntrees();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", surChangement);
    const surClavier = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOuvert(false);
    };
    const surClic = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (menuRef.current?.contains(cible) || boutonRef.current?.contains(cible)) return;
      setOuvert(false);
    };
    window.addEventListener("keydown", surClavier);
    window.addEventListener("mousedown", surClic);
    return () => {
      vivant = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", surChangement);
      window.removeEventListener("keydown", surClavier);
      window.removeEventListener("mousedown", surClic);
    };
  }, [ouvert, relireSorties, relireEntrees]);

  function basculer() {
    if (ouvert) {
      setOuvert(false);
      return;
    }
    if (boutonRef.current) setPosition(calculerPosition(boutonRef.current));
    setErreur("");
    setOuvert(true);
  }

  async function choisirMicro(deviceId: string) {
    if (occupe || deviceId === microCourant) return;
    setOccupe(true);
    setErreur("");
    try {
      await demanderPatchConfigVoix({ stt: { inputDeviceId: deviceId } });
      journalChoixMicro(deviceId);
    } catch (err) {
      const message = toMessage(err);
      journalPanneChoixMicro(message);
      setErreur(`Micro non enregistré : ${message}`);
    } finally {
      setOccupe(false);
    }
  }

  /**
   * Entrée SYSTÈME : bascule le défaut du poste, puis remet le micro web mémorisé à
   * « défaut » s'il y en avait un (il primerait sinon, le choix serait sans effet).
   * Un clic sur l'entrée déjà par défaut reste utile quand un micro web prime encore.
   */
  async function choisirEntree(nom: string, dejaParDefaut: boolean) {
    if (occupe || (dejaParDefaut && microCourant === "")) return;
    setOccupe(true);
    setErreur("");
    try {
      if (!dejaParDefaut) await choisirEntreeAudio(nom);
      if (microCourant !== "") await demanderPatchConfigVoix({ stt: { inputDeviceId: "" } });
      journalChoixEntreeSysteme(nom, microCourant !== "");
    } catch (err) {
      const message = toMessage(err);
      journalPanneChoixEntree(nom, message);
      setErreur(`Entrée non changée : ${message}`);
    } finally {
      // Relue dans tous les cas : la coche reflète l'état RÉEL du système, pas le clic.
      await relireEntrees();
      setOccupe(false);
    }
  }

  async function choisirSortie(nom: string) {
    if (occupe) return;
    setOccupe(true);
    setErreur("");
    try {
      await choisirSortieAudio(nom);
    } catch (err) {
      const message = toMessage(err);
      journalPanneChoixSortie(nom, message);
      setErreur(`Sortie non changée : ${message}`);
    } finally {
      // Relue dans tous les cas : la coche reflète l'état RÉEL du système, pas le clic.
      await relireSorties();
      setOccupe(false);
    }
  }

  const entreSysteme = entrees?.prisEnCharge === true && !entreesEchec;
  // Micros web : seulement si le système ne sait pas faire (ou si sa lecture a échoué).
  const microsWeb = (entrees !== null && !entrees.prisEnCharge) || entreesEchec;
  const entreesWeb = construireEntreesMicro(micros, microCourant);
  const titre = desactive
    ? "Micro ouvert — le choix du micro et de la sortie s'applique à la prochaine écoute"
    : "Choisir le micro et la sortie audio";

  const menu = ouvert && position && (
    <div
      ref={menuRef}
      className="menu-audio"
      role="menu"
      aria-label="Micro et sortie audio"
      style={{ ...position, width: LARGEUR_MENU, maxHeight: HAUTEUR_MAX_MENU }}
    >
      <div
        className="menu-audio__titre"
        id="menu-audio-micro"
        title={
          entreSysteme
            ? "Change l'entrée par défaut du système : toutes les applications captent là, pas seulement IAction."
            : undefined
        }
      >
        {entreSysteme ? "Micro — entrée du système" : "Micro"}
      </div>
      {entreSysteme && microCourant !== "" && (
        <div className="menu-audio__vide">
          Un micro choisi dans Configuration › Voix prime sur le système : il sera remplacé par votre choix.
        </div>
      )}
      <div role="group" aria-labelledby="menu-audio-micro">
        {entreSysteme && entrees.peripheriques.length === 0 && (
          <div className="menu-audio__vide">Aucune entrée audio détectée.</div>
        )}
        {entreSysteme &&
          entrees.peripheriques.map((entree) => {
            // La coche dit ce qui sera RÉELLEMENT capté : tant qu'un micro web est
            // mémorisé, c'est lui, et aucune entrée système n'est cochée.
            const coche = entree.parDefaut && microCourant === "";
            return (
              <button
                key={entree.nom}
                type="button"
                role="menuitemradio"
                aria-checked={coche}
                className="menu-audio__entree"
                disabled={occupe}
                onClick={() => void choisirEntree(entree.nom, entree.parDefaut)}
              >
                <span className="menu-audio__coche" aria-hidden="true">
                  {coche ? "✓" : ""}
                </span>
                {libelleAvecEtat(entree)}
              </button>
            );
          })}
        {microsWeb &&
          entreesWeb.map((entree) => (
            <button
              key={entree.valeur === "" ? "__defaut__" : entree.valeur}
              type="button"
              role="menuitemradio"
              aria-checked={entree.valeur === microCourant}
              className={`menu-audio__entree${entree.indisponible ? " menu-audio__entree--indisponible" : ""}`}
              disabled={occupe}
              onClick={() => void choisirMicro(entree.valeur)}
            >
              <span className="menu-audio__coche" aria-hidden="true">
                {entree.valeur === microCourant ? "✓" : ""}
              </span>
              {entree.libelle}
            </button>
          ))}
        {!entreSysteme && !microsWeb && <div className="menu-audio__vide">Lecture des entrées…</div>}
      </div>
      {sorties?.prisEnCharge && (
        <>
          <div
            className="menu-audio__titre"
            id="menu-audio-sortie"
            title="Change la sortie par défaut du système : tout le son du poste suit, pas seulement celui d'IAction."
          >
            Sortie — tout le son du poste suit
          </div>
          <div role="group" aria-labelledby="menu-audio-sortie">
            {sorties.peripheriques.length === 0 && <div className="menu-audio__vide">Aucune sortie audio détectée.</div>}
            {sorties.peripheriques.map((sortie) => (
              <button
                key={sortie.nom}
                type="button"
                role="menuitemradio"
                aria-checked={sortie.parDefaut}
                className="menu-audio__entree"
                disabled={occupe}
                onClick={() => void choisirSortie(sortie.nom)}
              >
                <span className="menu-audio__coche" aria-hidden="true">
                  {sortie.parDefaut ? "✓" : ""}
                </span>
                {libelleAvecEtat(sortie)}
              </button>
            ))}
          </div>
        </>
      )}
      {erreur && (
        <div className="menu-audio__erreur" role="alert">
          {erreur}
        </div>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={boutonRef}
        type="button"
        className="btn btn--ghost mic-menu-btn"
        onClick={basculer}
        disabled={desactive}
        aria-haspopup="menu"
        aria-expanded={ouvert}
        title={titre}
        aria-label={titre}
      >
        ▾
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
