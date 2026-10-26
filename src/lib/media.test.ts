import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Sound = typeof import("./sound");
type Voice = typeof import("./audio");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the production modules in an isolated browser-like context. Only the
// browser boundary and Vite's base URL are supplied by this deterministic fixture.
const compiled = new Map(["sound", "audio"].map((name) => {
  const source = fs.readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8").replaceAll("import.meta.env.BASE_URL", '"/"');
  return [name, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText];
}));

function fixture() {
  const requests: { url: string; cache?: RequestCache; response: ReturnType<typeof deferred<Response>> }[] = [];
  class Gain {
    gain = {
      value: 1,
      cancelScheduledValues() {},
      setValueAtTime(value: number) { this.value = value; },
      linearRampToValueAtTime(value: number) { this.value = value; },
    };
    connect(target: unknown) { return target; }
  }
  class Source {
    buffer: { duration: number; marker: number } | null = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    starts = 0;
    stops = 0;
    gain: Gain | null = null;
    connect(target: Gain) { this.gain = target; return target; }
    start() { this.starts++; }
    stop() { this.stops++; }
  }
  const sources: Source[] = [];
  class AudioContext {
    state = "running";
    currentTime = 100;
    destination = {};
    createGain() { return new Gain(); }
    createBufferSource() { const source = new Source(); sources.push(source); return source; }
    resume() { return Promise.resolve(); }
    decodeAudioData(bytes: ArrayBuffer) {
      const marker = new Uint8Array(bytes)[0];
      return marker === 255 ? Promise.reject(new Error("decode failed")) : Promise.resolve({ duration: 1, marker });
    }
  }
  const recordings: Recording[] = [];
  let onPlay: ((audio: Recording) => Promise<void>) | undefined;
  class Recording {
    playbackRate = 1;
    ended = false;
    paused = true;
    onended: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onerror: (() => void) | null = null;
    started = deferred<void>();
    constructor(readonly url: string) { recordings.push(this); }
    play() { this.paused = false; return onPlay ? onPlay(this) : this.started.promise; }
    pause() { this.paused = true; this.onpause?.(); }
    end() { this.ended = true; this.onended?.(); }
  }
  class Utterance {
    lang = "";
    rate = 1;
    voice: unknown;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
  }
  const spoken: Utterance[] = [];
  const speech = {
    getVoices: () => [],
    speak(utterance: Utterance) { spoken.push(utterance); },
    // Real implementations may omit end/error when a queued utterance is canceled.
    cancel() {},
  };
  const context = vm.createContext({
    window: { AudioContext, speechSynthesis: speech },
    Audio: Recording, SpeechSynthesisUtterance: Utterance,
    fetch(url: string, options?: RequestInit) { const response = deferred<Response>(); requests.push({ url, cache: options?.cache, response }); return response.promise; },
  });
  function load<T>(name: string, imports: Record<string, unknown> = {}): T {
    const exports = {};
    const run = vm.runInContext(`(function(exports, require) { ${compiled.get(name)}\n })`, context);
    run(exports, (id: string) => {
      assert.ok(id in imports, `Unexpected import ${id}`);
      return imports[id];
    });
    return exports as T;
  }
  const sound = load<Sound>("sound");
  const voice = load<Voice>("audio", { "./sound": sound });
  const respond = (number: number, marker = 1, status = 200) => {
    assert.ok(requests[number], `Missing request ${number}`);
    requests[number].response.resolve(new Response(new Uint8Array([marker]), { status }));
  };
  return { sound, voice, requests, sources, recordings, spoken, respond, onPlay(callback: (audio: Recording) => Promise<void>) { onPlay = callback; } };
}

async function ambience(f: ReturnType<typeof fixture>) {
  const pending = f.sound.setAmbience("rain", 0.5);
  f.respond(0);
  await pending;
  assert.equal(f.sources.length, 1);
  return f.sources[0].gain!.gain;
}

test("turning ambience off invalidates a still-loading selection", async () => {
  const f = fixture();
  const pending = f.sound.setAmbience("stars");
  await f.sound.setAmbience(null);
  f.respond(0);
  await pending;
  assert.equal(f.sound.ambienceId(), null);
  assert.equal(f.sources.length, 0);
});

test("the latest ambience wins when network responses complete out of order", async () => {
  const f = fixture();
  const stars = f.sound.setAmbience("stars");
  const rain = f.sound.setAmbience("rain");
  f.respond(1, 2);
  await rain;
  f.respond(0, 1);
  await stars;
  assert.equal(f.sound.ambienceId(), "rain");
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].buffer?.marker, 2);
});

test("a volume change during ambience loading shares its request and uses the latest volume", async () => {
  const f = fixture();
  const first = f.sound.setAmbience("stars", 0.1);
  const latest = f.sound.setAmbience("stars", 0.8);
  assert.equal(f.requests.length, 1);
  f.respond(0);
  await Promise.all([first, latest]);
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].gain?.gain.value, 0.8 * 0.9);
});

test("an offline or HTTP sound failure is evicted and the next cue retries", async () => {
  const f = fixture();
  const first = f.sound.cue("correct");
  f.respond(0, 1, 503);
  await first;
  assert.equal(f.sources.length, 0);
  const retry = f.sound.cue("correct");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].cache, "reload", "retry must refresh a failed runtime cache entry");
  f.respond(1);
  await retry;
  assert.equal(f.sources[0].starts, 1);
});

test("a decode failure is retryable while simultaneous successful cues share one download", async () => {
  const f = fixture();
  const first = f.sound.cue("wrong");
  f.respond(0, 255);
  await first;
  const second = f.sound.cue("wrong");
  const third = f.sound.cue("wrong");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].cache, "reload", "a cached 200 with undecodable audio must be replaceable");
  f.respond(1);
  await Promise.all([second, third]);
  assert.equal(f.sources.length, 2);
  assert.ok(f.sources.every((source) => source.starts === 1));
});

test("an older pronunciation settling cannot unduck a newer pronunciation", async () => {
  const f = fixture();
  const gain = await ambience(f);
  const first = f.voice.play("one.mp3", "one");
  const second = f.voice.play("two.mp3", "two");
  assert.equal(await first, "stopped");
  assert.equal(f.recordings[0].paused, true);
  assert.equal(gain.value, 0.5 * 0.35 * 0.9);
  f.recordings[1].end();
  assert.equal(await second, "recorded");
  assert.equal(gain.value, 0.5 * 0.9);
});

test("stop settles a pending play promise immediately and late failure never starts device speech", async () => {
  const f = fixture();
  const gain = await ambience(f);
  const pending = f.voice.play("slow.mp3", "slow");
  f.voice.stopAudio();
  assert.equal(await pending, "stopped");
  assert.equal(gain.value, 0.5 * 0.9);
  f.recordings[0].started.reject(new Error("late network error"));
  await tick();
  assert.equal(f.spoken.length, 0);
});

test("a very short recording ending before play resolves is observed", async () => {
  const f = fixture();
  f.onPlay((audio) => { audio.end(); return Promise.resolve(); });
  assert.equal(await f.voice.play("short.mp3", "short"), "recorded");
  assert.equal(f.spoken.length, 0);
});

test("a natural final pause before the ended event is still a completed recording", async () => {
  const f = fixture();
  const pending = f.voice.play("natural.mp3", "natural");
  f.recordings[0].started.resolve();
  f.recordings[0].ended = true;
  f.recordings[0].pause();
  f.recordings[0].onended?.();
  assert.equal(await pending, "recorded");
  assert.equal(f.spoken.length, 0);
});

test("a recording error after playback starts falls back to device speech and settles", async () => {
  const f = fixture();
  const pending = f.voice.play("broken.mp3", "hello", "us");
  f.recordings[0].started.resolve();
  await tick();
  f.recordings[0].onerror?.();
  await tick();
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].lang, "en-US");
  f.spoken[0].onend?.();
  assert.equal(await pending, "device");
});

test("canceling silent device speech settles even when the platform emits no event", async () => {
  const f = fixture();
  const first = f.voice.play(null, "one");
  const second = f.voice.play(null, "two");
  assert.equal(await first, "stopped");
  f.voice.stopAudio();
  assert.equal(await second, "stopped");
  assert.equal(f.spoken.length, 2);
});
