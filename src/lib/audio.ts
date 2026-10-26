import { duck } from "./sound";

let current: HTMLAudioElement | null = null;
let token = 0;
let cancelCurrent: (() => void) | null = null;

type Playback = "recorded" | "device" | "unsupported" | "stopped";
type Recording = "recorded" | "failed" | "stopped";

export function stopAudio() {
  token++;
  const cancel = cancelCurrent;
  cancelCurrent = null;
  cancel?.();
  const audio = current;
  current = null;
  audio?.pause();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  duck(false);
}

/** Play a recording, falling back to the device voice. Resolves on end or cancellation. */
export async function play(url: string | null | undefined, text: string, accent: "uk" | "us" = "uk", rate = 1): Promise<Playback> {
  stopAudio();
  const mine = token;
  duck(true);
  try {
    return await speak(url, text, accent, rate, mine);
  } finally {
    // A superseded request must never restore the volume under a newer voice.
    if (mine === token) {
      current = null;
      cancelCurrent = null;
      duck(false);
    }
  }
}

function recording(audio: HTMLAudioElement, mine: number): Promise<Recording> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Recording) => {
      if (settled) return;
      settled = true;
      audio.onended = audio.onpause = audio.onerror = null;
      if (mine === token) cancelCurrent = null;
      resolve(result);
    };
    // Register before play(): a short recording or cancellation can finish before
    // the play promise settles. Explicit cancellation also handles pending play().
    audio.onended = () => finish("recorded");
    // Some browsers dispatch the final pause before ended, with ended already true.
    audio.onpause = () => finish(audio.ended ? "recorded" : "stopped");
    audio.onerror = () => finish("failed");
    cancelCurrent = () => finish("stopped");
    try {
      void audio.play().then(() => {
        if (mine !== token) finish("stopped");
        else if (audio.ended) finish("recorded");
      }, () => finish(mine === token ? "failed" : "stopped"));
    } catch {
      finish("failed");
    }
  });
}

async function speak(url: string | null | undefined, text: string, accent: "uk" | "us", rate: number, mine: number): Promise<Playback> {
  if (url) {
    let audio: HTMLAudioElement | null = null;
    try { audio = new Audio(url); } catch { /* Device speech remains available. */ }
    if (audio) {
      audio.playbackRate = rate;
      current = audio;
      const result = await recording(audio, mine);
      if (mine !== token) return "stopped";
      if (current === audio) current = null;
      if (result !== "failed") return result;
      audio.pause();
    }
  }
  if (mine !== token) return "stopped";
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return "unsupported";
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = accent === "uk" ? "en-GB" : "en-US";
  utterance.rate = rate * 0.95;
  const voices = synth.getVoices().filter((voice) => voice.lang.replace("_", "-") === utterance.lang);
  const best = voices.find((voice) => /premium|enhanced|natural|google/i.test(voice.name)) || voices[0];
  if (best) utterance.voice = best;
  return new Promise<Playback>((resolve) => {
    let settled = false;
    const finish = (result: Playback) => {
      if (settled) return;
      settled = true;
      utterance.onend = utterance.onerror = null;
      if (mine === token) cancelCurrent = null;
      resolve(mine === token ? result : "stopped");
    };
    utterance.onend = () => finish("device");
    utterance.onerror = () => finish("unsupported");
    cancelCurrent = () => finish("stopped");
    try { synth.speak(utterance); } catch { finish("unsupported"); }
  });
}
