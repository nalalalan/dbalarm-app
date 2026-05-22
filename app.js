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
};

const quietResetMs = 1000;

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

function relativeDbFromSamples(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(118, 20 * Math.log10(rms || 0.000001) + 100));
}

function playAlarmPulse() {
  const audioContext = state.audioContext;
  if (!audioContext) return;

  const start = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);
  gain.connect(audioContext.destination);

  [880, 1320].forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    oscillator.type = index === 0 ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.78, start + 0.38);
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(start + 0.4);
  });
}

function stopAlarm() {
  state.alarmActive = false;
  if (state.running) setState("listening", "listening");
}

function triggerAlarm(time) {
  if (time < state.alarmMutedUntil) return;
  if (!state.alarmActive) {
    state.alarmActive = true;
    setState("alarm", "high dB alarm");
  }
  if (time - state.lastPulseAt > 620) {
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

updateControls();
setState("off", "mic off");
