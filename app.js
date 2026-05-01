/**
 * 波形描画・簡易BPM推定・基準BPMに合わせた playbackRate ミックス
 * 書き出し: @soundtouchjs/core でピッチ保持タイムストレッチ（プレビューと同じ合計倍率）→ 32bit float WAV
 */

const HOP = 512;
const FRAME = 2048;

/** 固定バージョン（CDN import 用） */
const SOUNDTOUCH_ESM = "https://esm.sh/@soundtouchjs/core@1.0.10";

/** @type {Promise<Record<string, unknown>> | null} */
let soundTouchModulePromise = null;

function loadSoundTouchModule() {
  if (!soundTouchModulePromise) {
    soundTouchModulePromise = import(/* @vite-ignore */ /* webpackIgnore: true */ SOUNDTOUCH_ESM);
  }
  return soundTouchModulePromise;
}

/** @param {Float32Array[]} parts */
function concatFloat32Parts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * インターリーブ stereo float32 → IEEE float WAV（再量子化なし）
 * @param {Float32Array} interleavedStereo length は偶数
 * @param {number} sampleRate
 */
function interleavedStereoFloatToWavBlob(interleavedStereo, sampleRate) {
  const numChannels = 2;
  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = interleavedStereo.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buffer);
  let o = 0;
  const writeStr = (s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i));
  };
  writeStr("RIFF");
  dv.setUint32(o, 36 + dataBytes, true);
  o += 4;
  writeStr("WAVE");
  writeStr("fmt ");
  dv.setUint32(o, 16, true);
  o += 4;
  dv.setUint16(o, 3, true);
  o += 2;
  dv.setUint16(o, numChannels, true);
  o += 2;
  dv.setUint32(o, sampleRate, true);
  o += 4;
  dv.setUint32(o, sampleRate * blockAlign, true);
  o += 4;
  dv.setUint16(o, blockAlign, true);
  o += 2;
  dv.setUint16(o, 32, true);
  o += 2;
  writeStr("data");
  dv.setUint32(o, dataBytes, true);
  o += 4;
  new Float32Array(buffer, o, interleavedStereo.length).set(interleavedStereo);
  return new Blob([buffer], { type: "audio/wav" });
}

/** @param {Blob} blob @param {string} filename */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * ピッチを維持したままテンポのみ変更（SoundTouch）
 * @param {AudioBuffer} inputBuffer
 * @param {number} tempo 1=原曲、>1 高速、<1 低速（playbackRate と同様の時間比）
 */
async function stretchToInterleavedStereo(inputBuffer, tempo) {
  const ST = await loadSoundTouchModule();
  const SoundTouch = ST.SoundTouch;
  const SimpleFilter = ST.SimpleFilter;
  const WebAudioBufferSource = ST.WebAudioBufferSource;
  if (typeof SoundTouch !== "function" || typeof SimpleFilter !== "function" || typeof WebAudioBufferSource !== "function") {
    throw new Error("SoundTouch モジュールの形式が想定と異なります");
  }
  const st = new SoundTouch();
  st.stretch.setParameters(inputBuffer.sampleRate, 0, 0, 8);
  st.pitch = 1;
  st.rate = 1;
  st.tempo = tempo;

  const source = new WebAudioBufferSource(inputBuffer);
  const filter = new SimpleFilter(source, st);

  const chunkFrames = 8192;
  const chunk = new Float32Array(chunkFrames * 2);
  const parts = [];
  let cycles = 0;
  while (true) {
    const n = filter.extract(chunk, chunkFrames);
    if (n <= 0) break;
    parts.push(chunk.slice(0, n * 2));
    cycles += 1;
    if (cycles % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return concatFloat32Parts(parts);
}

/**
 * @param {string | null} originalName
 * @param {number} trackIndex
 * @param {number} masterBpm
 * @param {number} [totalRate] プレビューと同じ合計倍率（ファイル名に含める）
 */
function buildExportFilename(originalName, trackIndex, masterBpm, totalRate) {
  const raw = originalName || `track${trackIndex + 1}`;
  const base = raw
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\.[^/.\\]+$/i, "");
  const mb = Number.isInteger(masterBpm) ? String(masterBpm) : String(Math.round(masterBpm * 10) / 10);
  const rateTag =
    totalRate != null && Number.isFinite(totalRate)
      ? `_total${String(Math.round(totalRate * 1000) / 1000).replace(".", "p")}x`
      : "";
  return `${base}_master${mb}bpm${rateTag}_pitchhold_IEEE.wav`;
}

/** @type {AudioContext | null} */
let audioContext = null;

/** @typedef {{ buffer: AudioBuffer | null, estimatedBpm: number | null, originalName: string | null, startOffsetSec: number, editEndSec: number | null, rateMul: number, el: HTMLElement }} TrackState */

/** @type {() => void} */
let stopScrubPreviewFn = () => {};

/** @returns {AudioContext} */
function getContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/** @param {AudioBuffer} buffer */
function downmixMono(buffer) {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  const s = 1 / ch;
  for (let i = 0; i < n; i++) out[i] *= s;
  return out;
}

/**
 * エネルギー差分（簡易オンセット）から自己相関でBPMを推定
 * @param {Float32Array} mono
 * @param {number} sampleRate
 */
function estimateBpmFromMono(mono, sampleRate) {
  const energies = [];
  for (let i = 0; i + FRAME <= mono.length; i += HOP) {
    let sum = 0;
    for (let j = 0; j < FRAME; j++) {
      const v = mono[i + j];
      sum += v * v;
    }
    energies.push(Math.sqrt(sum / FRAME));
  }
  if (energies.length < 64) return null;

  const diff = new Float32Array(energies.length);
  for (let i = 1; i < energies.length; i++) {
    const d = energies[i] - energies[i - 1];
    diff[i] = d > 0 ? d : 0;
  }
  diff[0] = diff[1];

  const frameRate = sampleRate / HOP;
  const minBpm = 65;
  const maxBpm = 195;
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * frameRate));
  const maxLag = Math.min(diff.length - 2, Math.ceil((60 / minBpm) * frameRate));
  if (minLag > maxLag) return null;

  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    let c = 0;
    const lim = diff.length - L;
    for (let i = 0; i < lim; i++) c += diff[i] * diff[i + L];
    if (c > bestScore) {
      bestScore = c;
      bestLag = L;
    }
  }

  let bpm = (60 * frameRate) / bestLag;
  while (bpm < minBpm) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/**
 * @param {AudioBuffer} buffer
 * @param {number} startSec
 * @param {number} endSec
 */
async function sliceAudioBuffer(buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const d = buffer.duration;
  const start = Math.max(0, Math.min(startSec, d - 0.001));
  const end = Math.max(start + 0.01, Math.min(endSec, d));
  const dur = end - start;
  const length = Math.max(1, Math.ceil(dur * sr));
  const oac = new OfflineAudioContext(channels, length, sr);
  const src = oac.createBufferSource();
  src.buffer = buffer;
  src.connect(oac.destination);
  src.start(0, start, dur);
  return oac.startRendering();
}

/**
 * @param {TrackState} track
 */
function getPlayRange(track) {
  if (!track.buffer) return { start: 0, end: 0, duration: 0 };
  const d = track.buffer.duration;
  let start = track.startOffsetSec ?? 0;
  start = Math.max(0, Math.min(start, d - 0.001));
  let end = d;
  if (track.editEndSec != null && Number.isFinite(track.editEndSec)) {
    end = Math.min(d, Math.max(start + 0.01, track.editEndSec));
  }
  return { start, end, duration: end - start };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {AudioBuffer | null} buffer
 * @param {string} color
 * @param {number | null} [playheadSec] 再生ヘッド（秒）。buffer が無いときは無視
 * @param {number | null} [rangeEndSec] 範囲の終わり（秒）。null は末尾まで
 */
function drawWaveform(canvas, buffer, color, playheadSec = null, rangeEndSec = null) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !buffer) {
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width;
  const h = Math.max(40, Math.min(120, canvas.clientHeight || 56));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const mono = downmixMono(buffer);
  const step = Math.max(1, Math.floor(mono.length / w));
  const mid = h / 2;
  const amp = mid * 0.92;

  ctx.fillStyle = "#0a0c12";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const start = x * step;
    let min = 1;
    let max = -1;
    const end = Math.min(start + step, mono.length);
    for (let i = start; i < end; i++) {
      const v = mono[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x + 0.5, mid - max * amp);
    ctx.lineTo(x + 0.5, mid - min * amp);
  }
  ctx.stroke();

  const dur = buffer.duration;
  if (dur > 0) {
    if (playheadSec != null && Number.isFinite(playheadSec) && playheadSec > 0) {
      const t = Math.min(playheadSec, dur);
      const x0 = (t / dur) * w;
      ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
      ctx.fillRect(0, 0, x0, h);
    }
    const endT = rangeEndSec != null && Number.isFinite(rangeEndSec) ? Math.min(rangeEndSec, dur) : dur;
    if (endT < dur - 0.0005) {
      const x1 = (endT / dur) * w;
      ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
      ctx.fillRect(x1, 0, w - x1, h);
    }
  }

  if (playheadSec != null && Number.isFinite(playheadSec) && buffer.duration > 0) {
    const t = Math.max(0, Math.min(playheadSec, buffer.duration));
    const px = (t / buffer.duration) * w;
    ctx.strokeStyle = "rgba(255, 248, 220, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {AudioBuffer} buffer
 * @param {number} clientX
 */
function clientXToBufferTime(canvas, buffer, clientX) {
  const rect = canvas.getBoundingClientRect();
  const rw = rect.width || 1;
  const x = clientX - rect.left;
  const r = Math.max(0, Math.min(1, x / rw));
  return r * buffer.duration;
}

/** @param {TrackState} track @param {string} bpmText */
function setBpmDisplay(track, bpmText) {
  const bpmOut = track.el.querySelector(".bpm-out");
  if (bpmOut) bpmOut.textContent = bpmText;
}

/**
 * 基準BPM・推定BPMに基づく倍率 × トラック「速さ」スライダー
 * @param {TrackState} track
 * @param {HTMLInputElement} masterInput
 */
function effectivePlaybackRate(track, masterInput) {
  const master = parseFloat(masterInput.value);
  const mbpm = Number.isFinite(master) && master > 0 ? master : 120;
  const b = track.estimatedBpm;
  const base = b && b > 0 ? mbpm / b : 1;
  const mul = track.rateMul ?? 1;
  const m = Number.isFinite(mul) && mul > 0 ? mul : 1;
  return base * m;
}

/** スライダー値を TrackState に反映（書き出し直前など） */
function syncRateMulFromUi(track) {
  const rateMulEl = track.el.querySelector(".rate-mul");
  if (rateMulEl instanceof HTMLInputElement) {
    const v = parseFloat(rateMulEl.value);
    track.rateMul = Number.isFinite(v) && v > 0 ? v : 1;
  }
}

/** @param {TrackState} track @param {HTMLInputElement} masterInput */
function refreshTrackRateDisplay(track, masterInput) {
  const total = effectivePlaybackRate(track, masterInput);
  const r = track.el.querySelector(".rate-out");
  if (r) r.textContent = total.toFixed(3);
  const lab = track.el.querySelector(".rate-mul-label");
  if (lab) lab.textContent = (track.rateMul ?? 1).toFixed(2);
}

/**
 * @param {TrackState[]} tracks
 * @param {HTMLInputElement} masterInput
 */
function updateRatesFromMaster(tracks, masterInput) {
  for (const t of tracks) {
    refreshTrackRateDisplay(t, masterInput);
  }
  for (const { src, track: tr } of activeMix) {
    src.playbackRate.value = effectivePlaybackRate(tr, masterInput);
  }
}

/** @type {AudioBufferSourceNode[]} */
let activeSources = [];

/** @type {{ src: AudioBufferSourceNode; track: TrackState }[]} */
let activeMix = [];

/** @type {(() => void)[]} */
let mixCleanup = [];

function stopPlayback() {
  stopScrubPreviewFn();
  for (const fn of mixCleanup) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  mixCleanup = [];
  for (const s of activeSources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  activeSources = [];
  activeMix = [];
}

/**
 * @param {TrackState[]} tracks
 * @param {HTMLInputElement} masterInput
 */
async function playMix(tracks, masterInput) {
  const ctx = getContext();
  if (ctx.state === "suspended") await ctx.resume();

  stopPlayback();

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;
  masterGain.connect(ctx.destination);

  for (const t of tracks) {
    if (!t.buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.playbackRate.value = effectivePlaybackRate(t, masterInput);

    const g = ctx.createGain();
    const slider = t.el.querySelector(".gain");
    const vol = slider instanceof HTMLInputElement ? parseFloat(slider.value) : 0.7;
    g.gain.value = Number.isFinite(vol) ? vol : 0.7;

    if (slider instanceof HTMLInputElement) {
      const onInput = () => {
        const v = parseFloat(slider.value);
        g.gain.value = Number.isFinite(v) ? v : 0;
      };
      slider.addEventListener("input", onInput);
      mixCleanup.push(() => slider.removeEventListener("input", onInput));
    }

    src.connect(g);
    g.connect(masterGain);
    const { start, duration } = getPlayRange(t);
    src.start(0, start, duration);
    activeSources.push(src);
    activeMix.push({ src, track: t });
  }
}

const BPM_HISTORY_MAX = 32;

function init() {
  const masterBpmInput = document.getElementById("masterBpm");
  const masterBpmSlider = document.getElementById("masterBpmSlider");
  const masterBpmSliderLabel = document.getElementById("masterBpmSliderLabel");
  const btnBpmUndo = document.getElementById("btnBpmUndo");
  const btnBpmRedo = document.getElementById("btnBpmRedo");
  const btnBpmReset = document.getElementById("btnBpmReset");
  const btnPlay = document.getElementById("btnPlay");
  const btnStop = document.getElementById("btnStop");
  const btnSync1 = document.getElementById("btnSyncTrack1");
  const btnSync2 = document.getElementById("btnSyncTrack2");

  if (
    !masterBpmInput ||
    !masterBpmSlider ||
    !btnBpmUndo ||
    !btnBpmRedo ||
    !btnBpmReset ||
    !btnPlay ||
    !btnStop ||
    !btnSync1 ||
    !btnSync2 ||
    !(masterBpmInput instanceof HTMLInputElement) ||
    !(masterBpmSlider instanceof HTMLInputElement) ||
    !(btnBpmUndo instanceof HTMLButtonElement) ||
    !(btnBpmRedo instanceof HTMLButtonElement) ||
    !(btnBpmReset instanceof HTMLButtonElement)
  ) {
    return;
  }

  const layerStack = document.getElementById("layerStack");
  const panels = layerStack
    ? Array.from(layerStack.querySelectorAll(".track")).sort(
        (a, b) => Number(a.dataset.track) - Number(b.dataset.track),
      )
    : Array.from(document.querySelectorAll(".track")).sort(
        (a, b) => Number(a.dataset.track) - Number(b.dataset.track),
      );
  /** @type {TrackState[]} */
  const tracks = panels.map((el) => ({
    buffer: null,
    estimatedBpm: null,
    originalName: null,
    startOffsetSec: 0,
    editEndSec: null,
    rateMul: 1,
    el,
  }));

  const colors = ["#6c9eff", "#c78bff"];

  const initialMasterBpm = (() => {
    const v = parseFloat(masterBpmInput.getAttribute("value") || masterBpmInput.defaultValue || "120");
    return Number.isFinite(v) && v > 0 ? Math.min(240, Math.max(40, v)) : 120;
  })();

  /** @type {number[]} */
  let bpmHistory = [];
  let bpmHistIdx = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let bpmCommitTimer = null;

  function readMasterClamped() {
    const v = parseFloat(masterBpmInput.value);
    if (!Number.isFinite(v) || v <= 0) return 120;
    return Math.min(240, Math.max(40, v));
  }

  function formatBpmDisplay(v) {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  }

  function syncSliderAndLabelFromInput() {
    const v = readMasterClamped();
    masterBpmSlider.value = String(v);
    if (masterBpmSliderLabel) masterBpmSliderLabel.textContent = formatBpmDisplay(v);
  }

  function updateUndoRedoButtons() {
    btnBpmUndo.disabled = bpmHistIdx <= 0;
    btnBpmRedo.disabled = bpmHistIdx >= bpmHistory.length - 1;
  }

  function commitBpmHistoryNow() {
    const v = readMasterClamped();
    if (bpmHistory.length === 0) {
      bpmHistory = [v];
      bpmHistIdx = 0;
      updateUndoRedoButtons();
      return;
    }
    if (Math.abs(v - bpmHistory[bpmHistIdx]) < 0.01) return;
    bpmHistory = bpmHistory.slice(0, bpmHistIdx + 1);
    bpmHistory.push(v);
    while (bpmHistory.length > BPM_HISTORY_MAX) bpmHistory.shift();
    bpmHistIdx = bpmHistory.length - 1;
    updateUndoRedoButtons();
  }

  function scheduleCommitBpm() {
    if (bpmCommitTimer) clearTimeout(bpmCommitTimer);
    bpmCommitTimer = setTimeout(() => {
      bpmCommitTimer = null;
      commitBpmHistoryNow();
    }, 380);
  }

  function applyMasterBpmFromHistory(idx) {
    const v = bpmHistory[idx];
    if (v == null || !Number.isFinite(v)) return;
    masterBpmInput.value = formatBpmDisplay(v);
    masterBpmSlider.value = String(Math.min(240, Math.max(40, v)));
    if (masterBpmSliderLabel) masterBpmSliderLabel.textContent = formatBpmDisplay(v);
    updateRatesFromMaster(tracks, masterBpmInput);
  }

  function undoMasterBpm() {
    if (bpmHistIdx <= 0) return;
    bpmHistIdx -= 1;
    applyMasterBpmFromHistory(bpmHistIdx);
    updateUndoRedoButtons();
  }

  function redoMasterBpm() {
    if (bpmHistIdx >= bpmHistory.length - 1) return;
    bpmHistIdx += 1;
    applyMasterBpmFromHistory(bpmHistIdx);
    updateUndoRedoButtons();
  }

  function resetMasterBpmToInitial() {
    masterBpmInput.value = formatBpmDisplay(initialMasterBpm);
    masterBpmSlider.value = String(initialMasterBpm);
    if (masterBpmSliderLabel) masterBpmSliderLabel.textContent = formatBpmDisplay(initialMasterBpm);
    updateRatesFromMaster(tracks, masterBpmInput);
    commitBpmHistoryNow();
  }

  bpmHistory = [readMasterClamped()];
  bpmHistIdx = 0;
  syncSliderAndLabelFromInput();
  updateUndoRedoButtons();

  function redrawTrackWave(track) {
    const idx = Number(track.el.dataset.track) || 0;
    const canvas = track.el.querySelector(".wave");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    drawWaveform(
      canvas,
      track.buffer,
      colors[idx] ?? "#6c9eff",
      track.buffer ? track.startOffsetSec : null,
      track.buffer ? track.editEndSec : null,
    );
  }

  /** @param {TrackState} track */
  function refreshEditMeta(track) {
    const totalEl = track.el.querySelector(".dur-total");
    const rangeEl = track.el.querySelector(".dur-range");
    const inp = track.el.querySelector(".edit-end");
    if (!track.buffer) {
      if (totalEl) totalEl.textContent = "—";
      if (rangeEl) rangeEl.textContent = "—";
      if (inp instanceof HTMLInputElement) {
        inp.disabled = true;
        inp.removeAttribute("max");
      }
      return;
    }
    if (inp instanceof HTMLInputElement) {
      inp.disabled = false;
      inp.max = String(track.buffer.duration);
    }
    if (totalEl) totalEl.textContent = `${track.buffer.duration.toFixed(2)} s`;
    const { duration } = getPlayRange(track);
    if (rangeEl) rangeEl.textContent = `${duration.toFixed(2)} s`;
  }

  /** @type {AudioBufferSourceNode | null} */
  let scrubSource = null;
  /** @type {GainNode | null} */
  let scrubGain = null;

  stopScrubPreviewFn = () => {
    if (scrubSource) {
      try {
        scrubSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        scrubSource.disconnect();
      } catch {
        /* ignore */
      }
      scrubSource = null;
    }
    if (scrubGain) {
      try {
        scrubGain.disconnect();
      } catch {
        /* ignore */
      }
      scrubGain = null;
    }
  };

  async function startScrubPreview(track, offsetSec) {
    if (!track.buffer) return;
    const ctx = getContext();
    if (ctx.state === "suspended") await ctx.resume();
    stopScrubPreviewFn();
    const buf = track.buffer;
    const { start, end } = getPlayRange(track);
    const clamped = Math.max(start, Math.min(offsetSec, end - 0.0005));
    const playDur = Math.max(0.01, end - clamped);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = effectivePlaybackRate(track, masterBpmInput);
    const g = ctx.createGain();
    g.gain.value = 0.75;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(0, clamped, playDur);
    scrubSource = src;
    scrubGain = g;
  }

  /**
   * @param {TrackState} track
   */
  function attachWavePointerHandlers(track) {
    const canvas = track.el.querySelector(".wave");
    if (!(canvas instanceof HTMLCanvasElement)) return;

    canvas.title =
      "左クリックまたはドラッグで再生位置を設定し、その位置から試聴します（ミックス再生もここから開始）";

    let dragging = false;
    /** @type {number | null} */
    let activePointerId = null;
    let lastScrubAt = 0;
    let lastScrubPos = -9999;

    const setPlayheadFromClientX = (clientX) => {
      if (!track.buffer) return;
      let t = clientXToBufferTime(canvas, track.buffer, clientX);
      const bufDur = track.buffer.duration;
      const endBound =
        track.editEndSec != null && Number.isFinite(track.editEndSec)
          ? Math.min(bufDur, track.editEndSec)
          : bufDur;
      t = Math.min(t, Math.max(0, endBound - 0.01));
      track.startOffsetSec = Math.max(0, t);
      redrawTrackWave(track);
      refreshEditMeta(track);
    };

    const maybeThrottleScrub = () => {
      const now = performance.now();
      const pos = track.startOffsetSec;
      if (now - lastScrubAt < 42 && Math.abs(pos - lastScrubPos) < 0.022) return;
      lastScrubAt = now;
      lastScrubPos = pos;
      void startScrubPreview(track, pos);
    };

    canvas.addEventListener("pointerdown", (e) => {
      if (!track.buffer || e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      dragging = true;
      activePointerId = e.pointerId;
      lastScrubAt = 0;
      lastScrubPos = -9999;
      stopPlayback();
      setPlayheadFromClientX(e.clientX);
      void startScrubPreview(track, track.startOffsetSec);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragging || e.pointerId !== activePointerId || !track.buffer) return;
      e.preventDefault();
      setPlayheadFromClientX(e.clientX);
      maybeThrottleScrub();
    });

    const endScrub = (e) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      stopScrubPreviewFn();
    };
    canvas.addEventListener("pointerup", endScrub);
    canvas.addEventListener("pointercancel", endScrub);
    canvas.addEventListener("lostpointercapture", () => {
      dragging = false;
      activePointerId = null;
      stopScrubPreviewFn();
    });
  }

  async function decodeFile(track, file) {
    const ctx = getContext();
    if (ctx.state === "suspended") await ctx.resume();
    const ab = await file.arrayBuffer();
    const copy = ab.slice(0);
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(copy);
    } catch (err) {
      const name = file.name || "ファイル";
      const hint =
        "このブラウザが対応していない形式の可能性があります。MP3 / WAV（PCM）に変換するか、別のブラウザでお試しください。";
      const wrapped = new Error(`${name} の読み込みに失敗しました。${hint}`);
      wrapped.cause = err;
      throw wrapped;
    }
    if (!buffer || buffer.length === 0) {
      throw new Error("デコード結果が空です。別のファイルでお試しください。");
    }
    track.buffer = buffer;
    track.originalName = file.name;
    track.startOffsetSec = 0;
    track.editEndSec = null;
    track.rateMul = 1;
    const rateMulInp = track.el.querySelector(".rate-mul");
    if (rateMulInp instanceof HTMLInputElement) rateMulInp.value = "1";
    const editInp = track.el.querySelector(".edit-end");
    if (editInp instanceof HTMLInputElement) {
      editInp.value = "";
      editInp.max = String(buffer.duration);
    }
    refreshEditMeta(track);
    const canvas = track.el.querySelector(".wave");
    if (canvas instanceof HTMLCanvasElement) {
      const idx = Number(track.el.dataset.track) || 0;
      drawWaveform(canvas, buffer, colors[idx] ?? "#6c9eff", track.startOffsetSec, track.editEndSec);
    }
    track.estimatedBpm = null;
    setBpmDisplay(track, "—");
    refreshTrackRateDisplay(track, masterBpmInput);
  }

  async function runEstimate(track) {
    if (!track.buffer) return;
    const mono = downmixMono(track.buffer);
    const bpm = estimateBpmFromMono(mono, track.buffer.sampleRate);
    track.estimatedBpm = bpm;
    setBpmDisplay(track, bpm != null ? String(bpm) : "—");
    updateRatesFromMaster(tracks, masterBpmInput);
  }

  /**
   * @param {TrackState} track
   * @param {number} trackIndex
   * @param {HTMLButtonElement} exportBtn
   */
  async function exportPitchHoldWav(track, trackIndex, exportBtn) {
    if (!track.buffer) {
      window.alert("先にオーディオファイルを読み込んでください。");
      return;
    }
    syncRateMulFromUi(track);
    refreshTrackRateDisplay(track, masterBpmInput);

    const master = parseFloat(masterBpmInput.value);
    const masterBpm = Number.isFinite(master) && master > 0 ? master : 120;
    const b = track.estimatedBpm;
    const tempo = effectivePlaybackRate(track, masterBpmInput);
    if (!(b && b > 0)) {
      const ok = window.confirm(
        "推定BPMがありません。基準BPMとの比率は 1.0 とみなし、画面上の「合計」倍率（速さスライダー含む）どおりにピッチ保持で書き出します。よろしいですか？",
      );
      if (!ok) return;
    }

    exportBtn.disabled = true;
    const prevLabel = exportBtn.textContent;
    exportBtn.textContent = "処理中…";
    try {
      const { start, end } = getPlayRange(track);
      const sliced = await sliceAudioBuffer(track.buffer, start, end);
      const interleaved = await stretchToInterleavedStereo(sliced, tempo);
      const blob = interleavedStereoFloatToWavBlob(interleaved, sliced.sampleRate);
      const name = buildExportFilename(track.originalName, trackIndex, masterBpm, tempo);
      downloadBlob(blob, name);
    } catch (err) {
      console.error(err);
      window.alert(
        "書き出しに失敗しました。ネットワークで初回のみライブラリ取得が必要です。コンソールを確認してください。",
      );
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = prevLabel;
    }
  }

  tracks.forEach((track) => {
    const rateMulEl = track.el.querySelector(".rate-mul");
    if (rateMulEl instanceof HTMLInputElement) {
      const v0 = parseFloat(rateMulEl.value);
      track.rateMul = Number.isFinite(v0) && v0 > 0 ? v0 : 1;
      rateMulEl.addEventListener("input", () => {
        const v = parseFloat(rateMulEl.value);
        track.rateMul = Number.isFinite(v) && v > 0 ? v : 1;
        refreshTrackRateDisplay(track, masterBpmInput);
        for (const { src, track: tr } of activeMix) {
          if (tr === track) {
            src.playbackRate.value = effectivePlaybackRate(tr, masterBpmInput);
          }
        }
      });
    }

    const fileIn = track.el.querySelector(".file-input");
    const estBtn = track.el.querySelector(".btn-estimate");
    const exportBtn = track.el.querySelector(".btn-export");
    const editEnd = track.el.querySelector(".edit-end");
    const editClear = track.el.querySelector(".btn-edit-clear");
    if (editEnd instanceof HTMLInputElement && editClear instanceof HTMLButtonElement) {
      refreshEditMeta(track);
      editEnd.addEventListener("input", () => {
        const raw = editEnd.value.trim();
        if (raw === "") {
          track.editEndSec = null;
        } else {
          const n = parseFloat(raw);
          track.editEndSec = Number.isFinite(n) ? n : null;
        }
        const { end } = getPlayRange(track);
        if (track.startOffsetSec > end - 0.01) {
          track.startOffsetSec = Math.max(0, end - 0.01);
        }
        redrawTrackWave(track);
        refreshEditMeta(track);
      });
      editClear.addEventListener("click", () => {
        editEnd.value = "";
        track.editEndSec = null;
        redrawTrackWave(track);
        refreshEditMeta(track);
      });
    }

    if (
      !(fileIn instanceof HTMLInputElement) ||
      !(estBtn instanceof HTMLButtonElement) ||
      !(exportBtn instanceof HTMLButtonElement)
    ) {
      return;
    }

    fileIn.addEventListener("change", async () => {
      const f = fileIn.files?.[0];
      if (!f) return;
      try {
        await decodeFile(track, f);
      } catch (e) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        window.alert(msg);
        setBpmDisplay(track, "—");
        track.buffer = null;
        track.estimatedBpm = null;
        track.originalName = null;
        track.startOffsetSec = 0;
        track.editEndSec = null;
        track.rateMul = 1;
        const rm = track.el.querySelector(".rate-mul");
        if (rm instanceof HTMLInputElement) rm.value = "1";
        const editInp = track.el.querySelector(".edit-end");
        if (editInp instanceof HTMLInputElement) {
          editInp.value = "";
          editInp.removeAttribute("max");
        }
        refreshEditMeta(track);
        const canvas = track.el.querySelector(".wave");
        if (canvas instanceof HTMLCanvasElement) {
          const ci = Number(track.el.dataset.track) || 0;
          drawWaveform(canvas, null, colors[ci] ?? "#6c9eff");
        }
        updateRatesFromMaster(tracks, masterBpmInput);
        fileIn.value = "";
        return;
      }
      try {
        await runEstimate(track);
      } catch (e) {
        console.error("BPM推定エラー（波形は読み込み済み）", e);
        setBpmDisplay(track, "—");
        track.estimatedBpm = null;
        updateRatesFromMaster(tracks, masterBpmInput);
      }
    });

    estBtn.addEventListener("click", () => runEstimate(track));

    exportBtn.addEventListener("click", () =>
      exportPitchHoldWav(track, Number(track.el.dataset.track) || 0, exportBtn),
    );
  });

  tracks.forEach((track) => attachWavePointerHandlers(track));

  if (layerStack) {
    let dragLayer = null;
    layerStack.querySelectorAll(".layer-head").forEach((head) => {
      head.addEventListener("dragstart", (e) => {
        dragLayer = head.closest(".track");
        if (!dragLayer) return;
        e.dataTransfer.setData("text/plain", dragLayer.dataset.track ?? "");
        e.dataTransfer.effectAllowed = "move";
        dragLayer.classList.add("layer-dragging");
      });
      head.addEventListener("dragend", () => {
        dragLayer?.classList.remove("layer-dragging");
        dragLayer = null;
      });
    });
    const allowDrop = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
    layerStack.addEventListener("dragover", allowDrop);
    layerStack.querySelectorAll(".track").forEach((row) => {
      row.addEventListener("dragover", allowDrop);
    });
    layerStack.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      const dragged = layerStack.querySelector(`[data-track="${id}"]`);
      if (!dragged || layerStack.querySelectorAll(".track").length < 2) return;
      layerStack.appendChild(dragged);
    });
  }

  function cancelBpmCommitTimer() {
    if (bpmCommitTimer) {
      clearTimeout(bpmCommitTimer);
      bpmCommitTimer = null;
    }
  }

  masterBpmInput.addEventListener("input", () => {
    syncSliderAndLabelFromInput();
    updateRatesFromMaster(tracks, masterBpmInput);
    scheduleCommitBpm();
  });
  masterBpmInput.addEventListener("change", () => {
    cancelBpmCommitTimer();
    const c = readMasterClamped();
    masterBpmInput.value = formatBpmDisplay(c);
    syncSliderAndLabelFromInput();
    updateRatesFromMaster(tracks, masterBpmInput);
    commitBpmHistoryNow();
  });

  masterBpmSlider.addEventListener("input", () => {
    const raw = parseFloat(masterBpmSlider.value);
    const v = Number.isFinite(raw) ? Math.min(240, Math.max(40, raw)) : readMasterClamped();
    masterBpmInput.value = formatBpmDisplay(v);
    if (masterBpmSliderLabel) masterBpmSliderLabel.textContent = formatBpmDisplay(v);
    updateRatesFromMaster(tracks, masterBpmInput);
    scheduleCommitBpm();
  });
  masterBpmSlider.addEventListener("pointerup", () => {
    cancelBpmCommitTimer();
    commitBpmHistoryNow();
  });

  btnBpmUndo.addEventListener("click", () => {
    cancelBpmCommitTimer();
    undoMasterBpm();
  });
  btnBpmRedo.addEventListener("click", () => {
    cancelBpmCommitTimer();
    redoMasterBpm();
  });
  btnBpmReset.addEventListener("click", () => {
    cancelBpmCommitTimer();
    resetMasterBpmToInitial();
  });

  const bpmPanel = document.querySelector("[data-bpm-panel]");
  bpmPanel?.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== "z") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "number") return;
    e.preventDefault();
    cancelBpmCommitTimer();
    if (e.shiftKey) redoMasterBpm();
    else undoMasterBpm();
  });

  btnSync1.addEventListener("click", () => {
    const b = tracks[0]?.estimatedBpm;
    if (b) {
      cancelBpmCommitTimer();
      masterBpmInput.value = formatBpmDisplay(b);
      syncSliderAndLabelFromInput();
      updateRatesFromMaster(tracks, masterBpmInput);
      commitBpmHistoryNow();
    }
  });
  btnSync2.addEventListener("click", () => {
    const b = tracks[1]?.estimatedBpm;
    if (b) {
      cancelBpmCommitTimer();
      masterBpmInput.value = formatBpmDisplay(b);
      syncSliderAndLabelFromInput();
      updateRatesFromMaster(tracks, masterBpmInput);
      commitBpmHistoryNow();
    }
  });

  tracks.forEach((track) => {
    const g = track.el.querySelector(".gain");
    if (g instanceof HTMLInputElement) {
      g.addEventListener("input", () => {
        /* 再生中のゲインは次回再生まで反映されない簡易仕様 */
      });
    }
  });

  btnPlay.addEventListener("click", async () => {
    const has = tracks.some((t) => t.buffer);
    if (!has) return;
    await playMix(tracks, masterBpmInput);
  });

  btnStop.addEventListener("click", () => stopPlayback());

  window.addEventListener("resize", () => {
    tracks.forEach((track) => redrawTrackWave(track));
  });
}

init();
