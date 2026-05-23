const elements = {
  breathCountValue: document.getElementById("breathCountValue"),
  breathRateValue: document.getElementById("breathRateValue"),
  breathSignalValue: document.getElementById("breathSignalValue"),
  dbValue: document.getElementById("dbValue"),
  holdInput: document.getElementById("holdInput"),
  holdValue: document.getElementById("holdValue"),
  meterFill: document.getElementById("meterFill"),
  micValue: document.getElementById("micValue"),
  peakValue: document.getElementById("peakValue"),
  resetValue: document.getElementById("resetValue"),
  silenceButton: document.getElementById("silenceButton"),
  startButton: document.getElementById("startButton"),
  statusText: document.getElementById("statusText"),
  thresholdInput: document.getElementById("thresholdInput"),
  thresholdValue: document.getElementById("thresholdValue"),
  wakeValue: document.getElementById("wakeValue"),
};

const state = {
  analyser: null,
  alarmPulseCount: 0,
  audioContext: null,
  alarmActive: false,
  alarmMutedUntil: 0,
  animationFrame: 0,
  buffer: null,
  breathActive: false,
  breathCandidatePeak: 0,
  breathCandidateStart: 0,
  breathCount: 0,
  breathEnvelope: 0,
  breathFloor: 0,
  breathInitialized: false,
  breathLastAt: 0,
  breathPeakSignal: 0,
  breathReady: true,
  breathRecent: [],
  breathStartedAt: 0,
  breathStatus: "idle",
  highSince: 0,
  lastHighAt: 0,
  lastPulseAt: 0,
  lastVoiceAt: 0,
  peak: 0,
  running: false,
  stream: null,
  wakeLock: null,
  wakeRetryTimer: 0,
};

const quietResetMs = 1000;
const wakeAlarmTone = Object.freeze({
  version: "wake-siren-520hz-v3",
  baseHz: 520,
  pulseIntervalMs: 260,
  pulseSeconds: 0.88,
  peakGain: 1,
  voiceIntervalMs: 4200,
  voicePhrase: "Wake up now",
});

const breathConfig = Object.freeze({
  version: "audio-envelope-v1",
  minGapMs: 1800,
  minActiveMs: 260,
  maxActiveMs: 6200,
  minSignalDb: 1.8,
  staleMs: 30000,
  rateWindowMs: 120000,
});

window.__dbalarmBreath = breathConfig;
window.__dbalarmTone = wakeAlarmTone;

function nowMs() {
  return performance.now();
}

function setState(nextState, text) {
  document.body.dataset.state = nextState;
  elements.statusText.textContent = text;
}

function updateControls() {
  const threshold = Number(elements.thresholdInput.value);
  const holdSeconds = Number(elements.holdInput.value);
  elements.thresholdValue.textContent = String(threshold);
  elements.holdValue.textContent = holdSeconds.toFixed(2).replace(/0$/, "");
  elements.resetValue.textContent = `${(quietResetMs / 1000).toFixed(1)}s`;
}

function estimateBreathRate() {
  const recent = state.breathRecent;
  if (recent.length < 2) return "--";
  const first = recent[0];
  const last = recent[recent.length - 1];
  const minutes = (last - first) / 60000;
  if (minutes <= 0) return "--";
  return ((recent.length - 1) / minutes).toFixed(1);
}

function setBreathStatus(text) {
  if (state.breathStatus !== text) {
    state.breathStatus = text;
  }
  if (elements.breathSignalValue) elements.breathSignalValue.textContent = text;
}

function updateBreathDisplay(status = state.breathStatus) {
  if (elements.breathCountValue) elements.breathCountValue.textContent = String(state.breathCount);
  if (elements.breathRateValue) elements.breathRateValue.textContent = estimateBreathRate();
  setBreathStatus(status);
}

function resetBreathTracker(time = nowMs()) {
  state.breathActive = false;
  state.breathCandidatePeak = 0;
  state.breathCandidateStart = 0;
  state.breathCount = 0;
  state.breathEnvelope = 0;
  state.breathFloor = 0;
  state.breathInitialized = false;
  state.breathLastAt = 0;
  state.breathPeakSignal = 0;
  state.breathReady = true;
  state.breathRecent = [];
  state.breathStartedAt = time;
  updateBreathDisplay(state.running ? "learning" : "idle");
}

function setWakeStatus(text) {
  if (elements.wakeValue) elements.wakeValue.textContent = text;
}

function scheduleWakeLockRetry(delayMs = 1200) {
  if (!state.running || document.visibilityState !== "visible") return;
  window.clearTimeout(state.wakeRetryTimer);
  state.wakeRetryTimer = window.setTimeout(() => {
    state.wakeRetryTimer = 0;
    requestWakeLock();
  }, delayMs);
}

async function requestWakeLock() {
  if (state.wakeLock) {
    setWakeStatus("awake");
    return;
  }
  if (!("wakeLock" in navigator)) {
    setWakeStatus("unsupported");
    return;
  }
  try {
    setWakeStatus("requesting");
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
      if (state.running) {
        setWakeStatus("reacquiring");
        scheduleWakeLockRetry(500);
      } else {
        setWakeStatus("off");
      }
    });
    setWakeStatus("awake");
  } catch (error) {
    console.warn("Screen wake lock unavailable", error);
    setWakeStatus("blocked");
    scheduleWakeLockRetry(5000);
  }
}

function releaseWakeLock() {
  window.clearTimeout(state.wakeRetryTimer);
  state.wakeRetryTimer = 0;
  if (!state.wakeLock) {
    setWakeStatus("off");
    return;
  }
  const wakeLock = state.wakeLock;
  state.wakeLock = null;
  wakeLock.release().catch(() => {});
  setWakeStatus("off");
}

function relativeDbFromSamples(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(118, 20 * Math.log10(rms || 0.000001) + 100));
}

function updateBreathTracker(db, time) {
  if (!state.breathInitialized) {
    state.breathEnvelope = db;
    state.breathFloor = db;
    state.breathPeakSignal = 0;
    state.breathStartedAt = time;
    state.breathInitialized = true;
    updateBreathDisplay("learning");
    return;
  }

  const riseAlpha = db > state.breathEnvelope ? 0.22 : 0.08;
  state.breathEnvelope = state.breathEnvelope * (1 - riseAlpha) + db * riseAlpha;
  if (state.breathEnvelope < state.breathFloor) {
    state.breathFloor = state.breathFloor * 0.96 + state.breathEnvelope * 0.04;
  } else {
    state.breathFloor = state.breathFloor * 0.998 + state.breathEnvelope * 0.002;
  }

  const signal = Math.max(0, state.breathEnvelope - state.breathFloor);
  state.breathPeakSignal = Math.max(signal, state.breathPeakSignal * 0.996);
  const high = Math.max(breathConfig.minSignalDb, Math.min(9, state.breathPeakSignal * 0.42));
  const low = Math.max(0.8, high * 0.45);
  const rearm = Math.max(1.2, high * 1.15);
  const sinceLast = state.breathLastAt ? time - state.breathLastAt : Number.POSITIVE_INFINITY;
  let status = time - state.breathStartedAt < 3500 ? "learning" : "listening";

  if (!state.breathActive && state.breathReady && signal >= high && sinceLast >= breathConfig.minGapMs) {
    state.breathActive = true;
    state.breathReady = false;
    state.breathCandidateStart = time;
    state.breathCandidatePeak = signal;
    status = "breath";
  } else if (state.breathActive) {
    state.breathCandidatePeak = Math.max(state.breathCandidatePeak, signal);
    const duration = time - state.breathCandidateStart;
    const release = Math.max(low, state.breathCandidatePeak * 0.78);
    status = "breath";

    if (signal <= release) {
      if (
        duration >= breathConfig.minActiveMs &&
        duration <= breathConfig.maxActiveMs &&
        sinceLast >= breathConfig.minGapMs &&
        state.breathCandidatePeak >= high
      ) {
        state.breathCount += 1;
        state.breathLastAt = time;
        state.breathRecent.push(time);
        state.breathRecent = state.breathRecent.filter((stamp) => time - stamp <= breathConfig.rateWindowMs);
        status = "counted";
      }
      state.breathActive = false;
      state.breathCandidateStart = 0;
      state.breathCandidatePeak = 0;
    } else if (duration > breathConfig.maxActiveMs) {
      state.breathActive = false;
      state.breathCandidateStart = 0;
      state.breathCandidatePeak = 0;
      status = "noise";
    }
  } else {
    if (signal <= rearm) state.breathReady = true;
    if (state.breathLastAt && time - state.breathLastAt > breathConfig.staleMs) {
    status = "quiet";
    }
  }

  updateBreathDisplay(status);
}

function createWakeDistortion(audioContext) {
  const shaper = audioContext.createWaveShaper();
  const sampleCount = 2048;
  const curve = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const x = (index * 2) / (sampleCount - 1) - 1;
    curve[index] = Math.tanh(x * 5.8);
  }
  shaper.curve = curve;
  shaper.oversample = "4x";
  return shaper;
}

function disconnectLater(nodes, delayMs) {
  window.setTimeout(() => {
    nodes.forEach((node) => {
      try {
        node.disconnect();
      } catch {
        // Already disconnected by the browser.
      }
    });
  }, delayMs);
}

function addAlarmVoice(audioContext, output, start, duration, options) {
  const oscillator = audioContext.createOscillator();
  const voiceGain = audioContext.createGain();
  oscillator.type = options.type;
  oscillator.frequency.setValueAtTime(options.fromHz, start);
  if (options.toHz && options.toHz !== options.fromHz) {
    oscillator.frequency.exponentialRampToValueAtTime(options.toHz, start + duration);
  }
  voiceGain.gain.setValueAtTime(0.0001, start);
  voiceGain.gain.exponentialRampToValueAtTime(options.gain, start + 0.012);
  voiceGain.gain.setValueAtTime(options.gain, start + duration - 0.035);
  voiceGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(voiceGain);
  voiceGain.connect(output);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
  oscillator.addEventListener("ended", () => {
    try {
      oscillator.disconnect();
      voiceGain.disconnect();
    } catch {
      // Already disconnected by the browser.
    }
  });
}

function addAlarmNoise(audioContext, output, start, duration) {
  const sampleCount = Math.floor(audioContext.sampleRate * duration);
  const buffer = audioContext.createBuffer(1, sampleCount, audioContext.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = (Math.random() * 2 - 1) * 0.38;
  }

  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const noiseGain = audioContext.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2600, start);
  filter.Q.setValueAtTime(0.95, start);
  noiseGain.gain.setValueAtTime(0.0001, start);
  noiseGain.gain.exponentialRampToValueAtTime(0.26, start + 0.018);
  noiseGain.gain.setValueAtTime(0.26, start + duration - 0.05);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(output);
  source.start(start);
  source.stop(start + duration);
  source.addEventListener("ended", () => {
    try {
      source.disconnect();
      filter.disconnect();
      noiseGain.disconnect();
    } catch {
      // Already disconnected by the browser.
    }
  });
}

function speakWakePhrase(time) {
  if (!("speechSynthesis" in window)) return;
  if (state.lastVoiceAt && time - state.lastVoiceAt < wakeAlarmTone.voiceIntervalMs) return;
  state.lastVoiceAt = time;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(wakeAlarmTone.voicePhrase);
    utterance.volume = 1;
    utterance.rate = 0.82;
    utterance.pitch = 0.45;
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find((voice) => /en(-|_)US/i.test(voice.lang)) || voices[0];
    if (preferredVoice) utterance.voice = preferredVoice;
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.warn("Wake voice unavailable", error);
  }
}

function cancelWakePhrase() {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Speech synthesis is best-effort.
  }
}

function playAlarmPulse() {
  const audioContext = state.audioContext;
  if (!audioContext) return;

  const start = audioContext.currentTime;
  const duration = wakeAlarmTone.pulseSeconds;
  const rising = state.alarmPulseCount % 2 === 0;
  state.alarmPulseCount += 1;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-28, start);
  compressor.knee.setValueAtTime(0, start);
  compressor.ratio.setValueAtTime(20, start);
  compressor.attack.setValueAtTime(0.002, start);
  compressor.release.setValueAtTime(0.055, start);
  compressor.connect(audioContext.destination);

  const distortion = createWakeDistortion(audioContext);
  distortion.connect(compressor);

  const masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.0001, start);
  masterGain.gain.exponentialRampToValueAtTime(wakeAlarmTone.peakGain, start + 0.035);
  masterGain.gain.setValueAtTime(wakeAlarmTone.peakGain, start + duration - 0.08);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  masterGain.connect(distortion);

  // Sleep-alarm evidence favors a low-frequency square wave around 520 Hz.
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz / 2,
    gain: 0.34,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz,
    gain: 0.76,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz * 2,
    gain: 0.5,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz * 3,
    gain: 0.26,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "sawtooth",
    fromHz: rising ? 1180 : 3100,
    toHz: rising ? 3100 : 1180,
    gain: 0.34,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "triangle",
    fromHz: rising ? 390 : 780,
    toHz: rising ? 780 : 390,
    gain: 0.24,
  });
  addAlarmNoise(audioContext, masterGain, start, duration);
  disconnectLater([masterGain, distortion, compressor], (duration + 0.25) * 1000);
}

function stopAlarm() {
  state.alarmActive = false;
  state.alarmPulseCount = 0;
  state.lastPulseAt = 0;
  state.lastVoiceAt = 0;
  cancelWakePhrase();
  if (state.running) setState("listening", "listening");
}

function triggerAlarm(time) {
  if (time < state.alarmMutedUntil) return;
  if (!state.alarmActive) {
    state.alarmActive = true;
    state.lastVoiceAt = 0;
    setState("alarm", "max wake siren");
  }
  if (time - state.lastPulseAt > wakeAlarmTone.pulseIntervalMs) {
    state.lastPulseAt = time;
    playAlarmPulse();
  }
  speakWakePhrase(time);
}

function sampleLoop() {
  if (!state.running || !state.analyser || !state.buffer) return;

  state.analyser.getByteTimeDomainData(state.buffer);
  const db = relativeDbFromSamples(state.buffer);
  const rounded = Math.round(db);
  const threshold = Number(elements.thresholdInput.value);
  const holdMs = Number(elements.holdInput.value) * 1000;
  const time = nowMs();

  state.peak = Math.max(state.peak, db);
  updateBreathTracker(db, time);
  elements.dbValue.textContent = String(rounded);
  elements.peakValue.textContent = `${Math.round(state.peak)} dB`;
  elements.meterFill.style.width = `${Math.max(3, Math.min(100, (db / 105) * 100))}%`;

  if (db >= threshold) {
    state.highSince = state.highSince || time;
    state.lastHighAt = time;
    if (time - state.highSince >= holdMs) {
      triggerAlarm(time);
    } else if (!state.alarmActive) {
      setState("armed", "above threshold");
    }
  } else {
    state.highSince = 0;
    if (state.alarmActive && time - state.lastHighAt > quietResetMs) {
      stopAlarm();
    } else if (!state.alarmActive) {
      setState("listening", "listening");
    }
  }

  state.animationFrame = requestAnimationFrame(sampleLoop);
}

async function startMic() {
  if (state.running) {
    stopMic();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setState("blocked", "mic unavailable");
    elements.micValue.textContent = "unavailable";
    return;
  }

  try {
    setState("armed", "requesting mic");
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = state.audioContext || new AudioContextClass();
    await state.audioContext.resume();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.72;
    state.buffer = new Uint8Array(state.analyser.fftSize);
    source.connect(state.analyser);

    state.running = true;
    state.peak = 0;
    resetBreathTracker();
    state.highSince = 0;
    state.lastHighAt = 0;
    state.lastPulseAt = 0;
    state.alarmPulseCount = 0;
    state.lastVoiceAt = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
    requestWakeLock();
    elements.startButton.textContent = "stop mic";
    elements.silenceButton.disabled = false;
    elements.micValue.textContent = "on";
    setState("listening", "listening");
    sampleLoop();
  } catch (error) {
    console.error(error);
    setState("blocked", "mic blocked");
    elements.micValue.textContent = "blocked";
    stopMic();
  }
}

function stopMic() {
  state.running = false;
  state.alarmActive = false;
  cancelAnimationFrame(state.animationFrame);
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  state.stream = null;
  state.analyser = null;
  state.buffer = null;
  state.highSince = 0;
  state.lastPulseAt = 0;
  state.alarmPulseCount = 0;
  state.lastVoiceAt = 0;
  cancelWakePhrase();
  releaseWakeLock();
  elements.startButton.textContent = "start mic";
  elements.silenceButton.disabled = true;
  elements.micValue.textContent = "off";
  elements.dbValue.textContent = "--";
  elements.meterFill.style.width = "0%";
  resetBreathTracker();
  setState("off", "mic off");
}

function silenceAlarm() {
  state.alarmMutedUntil = nowMs() + 10000;
  stopAlarm();
  setState("armed", "silenced 10s");
}

elements.startButton.addEventListener("click", startMic);
elements.silenceButton.addEventListener("click", silenceAlarm);
elements.thresholdInput.addEventListener("input", updateControls);
elements.holdInput.addEventListener("input", updateControls);
document.addEventListener("visibilitychange", () => {
  if (!state.running) return;
  if (document.visibilityState === "visible") {
    requestWakeLock();
  } else if (!state.wakeLock) {
    setWakeStatus("background");
  }
});
window.addEventListener("pageshow", () => {
  if (state.running) requestWakeLock();
});

updateControls();
resetBreathTracker();
setWakeStatus("off");
setState("off", "mic off");
