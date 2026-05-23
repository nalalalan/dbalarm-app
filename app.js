const elements = {
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
};

const state = {
  analyser: null,
  alarmPulseCount: 0,
  audioContext: null,
  alarmActive: false,
  alarmMutedUntil: 0,
  animationFrame: 0,
  buffer: null,
  highSince: 0,
  lastHighAt: 0,
  lastPulseAt: 0,
  peak: 0,
  running: false,
  stream: null,
  wakeLock: null,
};

const quietResetMs = 1000;
const wakeAlarmTone = Object.freeze({
  version: "wake-siren-520hz-v2",
  baseHz: 520,
  pulseIntervalMs: 360,
  pulseSeconds: 0.58,
  peakGain: 0.96,
});

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

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (error) {
    console.warn("Screen wake lock unavailable", error);
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  const wakeLock = state.wakeLock;
  state.wakeLock = null;
  wakeLock.release().catch(() => {});
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
  voiceGain.gain.exponentialRampToValueAtTime(options.gain, start + 0.025);
  voiceGain.gain.setValueAtTime(options.gain, start + duration - 0.06);
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
  filter.frequency.setValueAtTime(2200, start);
  filter.Q.setValueAtTime(0.85, start);
  noiseGain.gain.setValueAtTime(0.0001, start);
  noiseGain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
  noiseGain.gain.setValueAtTime(0.16, start + duration - 0.08);
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

function playAlarmPulse() {
  const audioContext = state.audioContext;
  if (!audioContext) return;

  const start = audioContext.currentTime;
  const duration = wakeAlarmTone.pulseSeconds;
  const rising = state.alarmPulseCount % 2 === 0;
  state.alarmPulseCount += 1;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-22, start);
  compressor.knee.setValueAtTime(1, start);
  compressor.ratio.setValueAtTime(18, start);
  compressor.attack.setValueAtTime(0.002, start);
  compressor.release.setValueAtTime(0.09, start);
  compressor.connect(audioContext.destination);

  const masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.0001, start);
  masterGain.gain.exponentialRampToValueAtTime(wakeAlarmTone.peakGain, start + 0.035);
  masterGain.gain.setValueAtTime(wakeAlarmTone.peakGain, start + duration - 0.08);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  masterGain.connect(compressor);

  // Sleep-alarm evidence favors a low-frequency square wave around 520 Hz.
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz,
    gain: 0.58,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "square",
    fromHz: wakeAlarmTone.baseHz * 2,
    gain: 0.28,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "sawtooth",
    fromHz: rising ? 1180 : 2450,
    toHz: rising ? 2450 : 1180,
    gain: 0.24,
  });
  addAlarmVoice(audioContext, masterGain, start, duration, {
    type: "triangle",
    fromHz: rising ? 390 : 780,
    toHz: rising ? 780 : 390,
    gain: 0.18,
  });
  addAlarmNoise(audioContext, masterGain, start, duration);
  disconnectLater([masterGain, compressor], (duration + 0.25) * 1000);
}

function stopAlarm() {
  state.alarmActive = false;
  state.alarmPulseCount = 0;
  state.lastPulseAt = 0;
  if (state.running) setState("listening", "listening");
}

function triggerAlarm(time) {
  if (time < state.alarmMutedUntil) return;
  if (!state.alarmActive) {
    state.alarmActive = true;
    setState("alarm", "wake siren");
  }
  if (time - state.lastPulseAt > wakeAlarmTone.pulseIntervalMs) {
    state.lastPulseAt = time;
    playAlarmPulse();
  }
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
    state.highSince = 0;
    state.lastHighAt = 0;
    state.lastPulseAt = 0;
    state.alarmPulseCount = 0;
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
  releaseWakeLock();
  elements.startButton.textContent = "start mic";
  elements.silenceButton.disabled = true;
  elements.micValue.textContent = "off";
  elements.dbValue.textContent = "--";
  elements.meterFill.style.width = "0%";
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
  if (document.visibilityState === "visible" && state.running) {
    requestWakeLock();
  }
});

updateControls();
setState("off", "mic off");
