/*
 * Ré-échantillonnage 48 kHz → 16 kHz : la seule propriété qui compte est
 * l'ABSENCE DE REPLIEMENT. Ces tests mesurent l'énergie de sortie sur des
 * sinusoïdes pures, au-dessus et au-dessous de la nouvelle fréquence de
 * Nyquist (8 kHz). L'interpolation linéaire que ce module utilisait avant
 * échouait au premier cas : un 12 kHz ressortait à 4 kHz, en plein dans les
 * fréquences des consonnes — voir l'en-tête de `resamplePcm`.
 */
import { describe, expect, it } from "vitest";
import { resamplePcm } from "./audioCapture";

/** Sinusoïde de `freq` Hz, `ms` millisecondes, échantillonnée à `rate`. */
function sine(freq: number, rate: number, ms: number): Float32Array {
  const n = Math.round((ms / 1000) * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Énergie moyenne (RMS), bords exclus : le noyau y déborde du signal. */
function rms(samples: Float32Array): number {
  const skip = Math.min(200, Math.floor(samples.length / 4));
  let sum = 0;
  let count = 0;
  for (let i = skip; i < samples.length - skip; i++) {
    sum += samples[i] * samples[i];
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

describe("resamplePcm — 48 kHz vers 16 kHz", () => {
  it("laisse passer la parole utile (1 kHz conservé à l'identique)", () => {
    const out = resamplePcm(sine(1000, 48000, 200), 48000, 16000);
    // Sinusoïde d'amplitude 1 → RMS théorique 0,707.
    expect(rms(out)).toBeGreaterThan(0.65);
  });

  it("supprime ce qui dépasse la nouvelle fréquence de Nyquist (12 kHz effacé)", () => {
    const out = resamplePcm(sine(12000, 48000, 200), 48000, 16000);
    // Sans filtre anti-repliement, ce 12 kHz reviendrait à 4 kHz avec une
    // énergie quasi intacte (~0,7). Le seuil vérifie qu'il ne reste rien.
    expect(rms(out)).toBeLessThan(0.02);
  });

  it("supprime aussi les fricatives hautes (15 kHz effacé)", () => {
    const out = resamplePcm(sine(15000, 48000, 200), 48000, 16000);
    expect(rms(out)).toBeLessThan(0.02);
  });

  it("longueur de sortie et cas identique", () => {
    const input = sine(440, 48000, 300);
    expect(resamplePcm(input, 48000, 16000).length).toBe(Math.floor(input.length / 3));
    expect(resamplePcm(input, 16000, 16000)).toBe(input);
  });
});
