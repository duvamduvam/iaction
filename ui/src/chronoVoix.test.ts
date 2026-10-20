/*
 * Chronométrage de la chaîne voix (T-149) : durées calculées sur une horloge
 * injectée, forme des champs journalisés, repère « fin de transcription »
 * pour les délais de premier texte et de premier son.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  transcrire: vi.fn(),
  synthetiser: vi.fn(),
  lecture: vi.fn(),
  config: vi.fn(),
  appelTranscription: vi.fn(),
  appelSynthese: vi.fn(),
  premierTexte: vi.fn(),
  premierSon: vi.fn(),
}));
vi.mock("./speechAdmin", () => ({
  speechTranscribe: m.transcrire,
  speechSynthesize: m.synthetiser,
  readSpeechConfig: m.config,
  formatSpeechProgress: () => "",
}));
vi.mock("./audioPlayback", () => ({ startPlaybackQueue: m.lecture }));
vi.mock("./journalVoix", () => ({
  journalAppelTranscription: m.appelTranscription,
  journalAppelSynthese: m.appelSynthese,
  journalPremierTexteReponse: m.premierTexte,
  journalPremierSonReponse: m.premierSon,
}));

import {
  creerChronoVoix,
  descripteurSynthese,
  descripteurTranscription,
  dureeAudioWavMs,
  VALIDITE_REPERE_MS,
} from "./chronoVoix";

const CONFIG = {
  stt: { mode: "remote", local: { model: "base" }, remote: { model: "openai/whisper" } },
  tts: { mode: "remote", local: { voice: "ff_siwis" }, remote: { model: "google/tts" } },
};

/** Horloge pilotée à la main. */
function horloge() {
  let t = 1000;
  return { now: () => t, avance: (ms: number) => void (t += ms) };
}

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.config.mockResolvedValue(CONFIG);
});

describe("dureeAudioWavMs", () => {
  it("déduit la durée de la taille base64 (44 octets d'en-tête, 32 octets par ms)", () => {
    const octets = 44 + 32 * 1500;
    const b64 = Buffer.alloc(octets).toString("base64");
    expect(dureeAudioWavMs(b64)).toBe(1500);
  });
  it("renvoie undefined pour du vide, du non-base64 ou un fichier plus court qu'un en-tête", () => {
    expect(dureeAudioWavMs("")).toBeUndefined();
    expect(dureeAudioWavMs("abc")).toBeUndefined();
    expect(dureeAudioWavMs(Buffer.alloc(10).toString("base64"))).toBeUndefined();
  });
});

describe("descripteurs mode / modèle", () => {
  it("distant : le modèle distant ; local : modèle STT, voix TTS", () => {
    const c = CONFIG as never;
    expect(descripteurTranscription(c)).toEqual({ mode: "remote", modele: "openai/whisper" });
    expect(descripteurSynthese(c)).toEqual({ mode: "remote", modele: "google/tts" });
    const l = { stt: { ...CONFIG.stt, mode: "local" }, tts: { ...CONFIG.tts, mode: "local" } } as never;
    expect(descripteurTranscription(l)).toEqual({ mode: "local", modele: "base" });
    expect(descripteurSynthese(l)).toEqual({ mode: "local", modele: "ff_siwis" });
  });
});

describe("speechTranscribe chronométré", () => {
  it("journalise durée, mode, modèle, durée audio et issue ok, sans toucher au résultat", async () => {
    const h = horloge();
    m.transcrire.mockImplementation(async () => {
      h.avance(900);
      return "bonjour";
    });
    const { speechTranscribe } = creerChronoVoix(h.now);
    const audio = Buffer.alloc(44 + 32 * 2000).toString("base64");
    await expect(speechTranscribe(audio)).resolves.toBe("bonjour");
    await vi.waitFor(() => expect(m.appelTranscription).toHaveBeenCalledTimes(1));
    expect(m.appelTranscription).toHaveBeenCalledWith("remote", "openai/whisper", 900, "ok", 2000);
  });

  it("journalise l'échec puis relance la MÊME erreur", async () => {
    const h = horloge();
    const erreur = new Error("réseau");
    m.transcrire.mockImplementation(async () => {
      h.avance(300);
      throw erreur;
    });
    const { speechTranscribe } = creerChronoVoix(h.now);
    await expect(speechTranscribe("AAAA")).rejects.toBe(erreur);
    await vi.waitFor(() => expect(m.appelTranscription).toHaveBeenCalledTimes(1));
    expect(m.appelTranscription).toHaveBeenCalledWith("remote", "openai/whisper", 300, "echec", undefined);
  });

  it("une config illisible perd la mesure, pas l'appel", async () => {
    m.config.mockRejectedValue(new Error("config"));
    m.transcrire.mockResolvedValue("ok");
    const { speechTranscribe } = creerChronoVoix(horloge().now);
    await expect(speechTranscribe("AAAA")).resolves.toBe("ok");
    await new Promise((r) => setTimeout(r, 0));
    expect(m.appelTranscription).not.toHaveBeenCalled();
  });
});

describe("speechSynthesize chronométré", () => {
  it("journalise durée, longueur du texte (jamais le texte) et rang du fragment", async () => {
    const h = horloge();
    m.synthetiser.mockImplementation(async () => {
      h.avance(1200);
      return { audioBase64: "x", mime: "audio/wav" };
    });
    const { speechSynthesize } = creerChronoVoix(h.now);
    await speechSynthesize("Bonjour à tous.");
    await speechSynthesize("Deuxième.");
    await vi.waitFor(() => expect(m.appelSynthese).toHaveBeenCalledTimes(2));
    expect(m.appelSynthese).toHaveBeenNthCalledWith(1, "remote", "google/tts", 1200, "ok", 15, 0);
    expect(m.appelSynthese).toHaveBeenNthCalledWith(2, "remote", "google/tts", 1200, "ok", 9, 1);
  });

  it("journalise l'échec et relance l'erreur", async () => {
    m.synthetiser.mockRejectedValue(new Error("429"));
    const { speechSynthesize } = creerChronoVoix(horloge().now);
    await expect(speechSynthesize("abc")).rejects.toThrow("429");
    await vi.waitFor(() => expect(m.appelSynthese).toHaveBeenCalledTimes(1));
    expect(m.appelSynthese).toHaveBeenCalledWith("remote", "google/tts", 0, "echec", 3, 0);
  });

  it("le rang repart de zéro à chaque nouvelle file de lecture", async () => {
    m.synthetiser.mockResolvedValue({ audioBase64: "x", mime: "audio/wav" });
    const c = creerChronoVoix(horloge().now);
    await c.speechSynthesize("a");
    c.startPlaybackQueue({} as never);
    await c.speechSynthesize("b");
    await vi.waitFor(() => expect(m.appelSynthese).toHaveBeenCalledTimes(2));
    expect(m.appelSynthese.mock.calls.map((a) => a[5])).toEqual([0, 0]);
  });
});

describe("délais de la réponse après une transcription", () => {
  /** Une transcription réussie qui se termine à t = 1000 + durée. */
  async function apresTranscription(c: ReturnType<typeof creerChronoVoix>, h: ReturnType<typeof horloge>) {
    m.transcrire.mockImplementation(async () => {
      h.avance(500);
      return "bonjour";
    });
    await c.speechTranscribe("AAAA");
  }

  it("mesure premier texte (1er appel de synthèse) puis premier son (onStarted), une fois chacun", async () => {
    const h = horloge();
    const c = creerChronoVoix(h.now);
    await apresTranscription(c, h);
    const onStarted = vi.fn();
    m.lecture.mockImplementation((cb) => ({ cb }));
    c.startPlaybackQueue({ onStarted } as never);

    m.synthetiser.mockResolvedValue({ audioBase64: "x", mime: "audio/wav" });
    h.avance(3500);
    await c.speechSynthesize("première phrase");
    h.avance(100);
    await c.speechSynthesize("seconde phrase");
    expect(m.premierTexte).toHaveBeenCalledTimes(1);
    expect(m.premierTexte).toHaveBeenCalledWith(3500);

    h.avance(400);
    m.lecture.mock.calls[0][0].onStarted();
    expect(m.premierSon).toHaveBeenCalledWith(4000);
    expect(onStarted).toHaveBeenCalledTimes(1);
    m.lecture.mock.calls[0][0].onStarted();
    expect(m.premierSon).toHaveBeenCalledTimes(1);
  });

  it("une transcription VIDE ne pose pas de repère", async () => {
    const h = horloge();
    const c = creerChronoVoix(h.now);
    m.transcrire.mockResolvedValue("   ");
    await c.speechTranscribe("AAAA");
    m.synthetiser.mockResolvedValue({ audioBase64: "x", mime: "audio/wav" });
    await c.speechSynthesize("x");
    expect(m.premierTexte).not.toHaveBeenCalled();
  });

  it("un repère périmé est ignoré (lecture à voix haute sans rapport avec la dictée)", async () => {
    const h = horloge();
    const c = creerChronoVoix(h.now);
    await apresTranscription(c, h);
    h.avance(VALIDITE_REPERE_MS + 1);
    m.synthetiser.mockResolvedValue({ audioBase64: "x", mime: "audio/wav" });
    await c.speechSynthesize("x");
    expect(m.premierTexte).not.toHaveBeenCalled();
  });
});
