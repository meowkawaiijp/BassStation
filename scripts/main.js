document.addEventListener('DOMContentLoaded', function() {
    const noteDisplay = document.querySelector('.note-display');
    const octaveDisplay = document.querySelector('.octave-display');
    const frequencyDisplay = document.querySelector('.frequency-display');
    const centsDisplay = document.getElementById('cents-display');
    const meterContainer = document.querySelector('.meter-container');
    const meterNeedle = document.querySelector('.meter-needle');
    const startButton = document.getElementById('start-button');
    const metronomeButton = document.getElementById('metronome-button');
    const tuningSelect = document.getElementById('tuning-select');
    const referenceSelect = document.getElementById('reference-select');
    const referenceStringsContainer = document.querySelector('.reference-strings');
    const statusMessage = document.getElementById('status-message');
    const sensitivitySlider = document.getElementById('sensitivity-slider');
    const sensitivityValue = document.getElementById('sensitivity-value');
    const tunerLive = document.getElementById('tuner-live');
    const waveformCanvas = document.getElementById('waveform-canvas');
    const waveformCtx = waveformCanvas.getContext('2d');

    const WAVEFORM_LAYOUT_WIDTH = 400;
    const WAVEFORM_LAYOUT_HEIGHT = 100;

    let isListening = false;
    let isMetronomeActive = false;
    let audioContext = null;
    let analyser = null;
    let microphone = null;
    let mediaStream = null;
    let metronomeInterval = null;
    let referenceFrequency = 440;
    let sensitivityMultiplier = parseFloat(sensitivitySlider.value) || 1;
    let noiseFloor = 0.005;
    let calibrationInProgress = false;
    let consecutiveFailedDetections = 0;
    const MAX_FAILED_DETECTIONS = 10;
    let lastAnnouncedTuning = '';
    let lastAnnounceTime = 0;
    const ANNOUNCE_INTERVAL_MS = 350;

    const tunings = {
      'standard': [
        { note: 'E', octave: 1, frequency: 41.20 },
        { note: 'A', octave: 1, frequency: 55.00 },
        { note: 'D', octave: 2, frequency: 73.42 },
        { note: 'G', octave: 2, frequency: 98.00 }
      ],
      'drop-d': [
        { note: 'D', octave: 1, frequency: 36.71 },
        { note: 'A', octave: 1, frequency: 55.00 },
        { note: 'D', octave: 2, frequency: 73.42 },
        { note: 'G', octave: 2, frequency: 98.00 }
      ],
      'five-string': [
        { note: 'B', octave: 0, frequency: 30.87 },
        { note: 'E', octave: 1, frequency: 41.20 },
        { note: 'A', octave: 1, frequency: 55.00 },
        { note: 'D', octave: 2, frequency: 73.42 },
        { note: 'G', octave: 2, frequency: 98.00 }
      ],
      'six-string': [
        { note: 'B', octave: 0, frequency: 30.87 },
        { note: 'E', octave: 1, frequency: 41.20 },
        { note: 'A', octave: 1, frequency: 55.00 },
        { note: 'D', octave: 2, frequency: 73.42 },
        { note: 'G', octave: 2, frequency: 98.00 },
        { note: 'C', octave: 3, frequency: 130.81 }
      ]
    };

    function resizeWaveformCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      waveformCanvas.width = Math.round(WAVEFORM_LAYOUT_WIDTH * dpr);
      waveformCanvas.height = Math.round(WAVEFORM_LAYOUT_HEIGHT * dpr);
      waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function applySensitivityFromSlider() {
      sensitivityMultiplier = parseFloat(sensitivitySlider.value) || 1;
      sensitivitySlider.setAttribute('aria-valuenow', String(sensitivityMultiplier));
      sensitivityValue.textContent = `${sensitivityMultiplier.toFixed(2)}x`;
    }

    function updateReferenceStrings() {
      referenceStringsContainer.innerHTML = '';
      const currentTuning = tunings[tuningSelect.value];

      currentTuning.forEach((string) => {
        const stringButton = document.createElement('div');
        stringButton.classList.add('string-button');
        stringButton.textContent = `${string.note}${string.octave}`;
        stringButton.setAttribute('role', 'button');
        stringButton.setAttribute('tabindex', '0');
        stringButton.setAttribute('aria-label', `参照音 ${string.note}${string.octave}`);

        stringButton.addEventListener('click', function() {
          playReferenceNote(string.note, string.octave, string.frequency * (referenceFrequency / 440));
          highlightReferenceButton(this);
        });
        stringButton.addEventListener('keydown', function(ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            playReferenceNote(string.note, string.octave, string.frequency * (referenceFrequency / 440));
            highlightReferenceButton(this);
          }
        });

        referenceStringsContainer.appendChild(stringButton);
      });
    }

    function playReferenceNote(note, octave, frequency) {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.7, audioContext.currentTime + 0.1);

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.start();
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 2);
      oscillator.stop(audioContext.currentTime + 2.1);

      noteDisplay.textContent = note;
      noteDisplay.style.color = 'var(--accent-color)';
      octaveDisplay.textContent = octave;
      frequencyDisplay.textContent = `${frequency.toFixed(2)} Hz`;

      setTimeout(() => {
        if (!isListening) {
          noteDisplay.textContent = '--';
          noteDisplay.style.color = 'var(--text-color)';
          octaveDisplay.textContent = '';
          frequencyDisplay.textContent = '0 Hz';
          centsDisplay.textContent = '';
          meterContainer.setAttribute('aria-valuenow', '0');
        }
      }, 2100);
    }

    function highlightReferenceButton(button) {
      const buttons = document.querySelectorAll('.string-button');
      buttons.forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');

      setTimeout(() => {
        button.classList.remove('active');
      }, 2000);
    }

    async function performAutoCalibration() {
      if (!analyser || calibrationInProgress) return;

      calibrationInProgress = true;
      updateStatus('環境音のキャリブレーション中...');

      const samples = 20;
      let totalNoise = 0;

      for (let i = 0; i < samples; i++) {
        const bufferLength = analyser.fftSize;
        const buffer = new Float32Array(bufferLength);
        analyser.getFloatTimeDomainData(buffer);

        let rms = 0;
        for (let j = 0; j < buffer.length; j++) {
          rms += buffer[j] * buffer[j];
        }
        rms = Math.sqrt(rms / buffer.length);

        totalNoise += rms;

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      noiseFloor = (totalNoise / samples) * 2.5;
      updateStatus('環境音のキャリブレーション完了');
      calibrationInProgress = false;
    }

    async function startListening() {
      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
          }
        });
        mediaStream = stream;

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.8;

        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);

        isListening = true;
        startButton.textContent = 'マイクをオフ';
        startButton.classList.add('active');
        startButton.setAttribute('aria-pressed', 'true');
        startButton.setAttribute('aria-label', 'マイク入力を停止');

        updateStatus('マイクがアクティブです。音を出してください。');

        await performAutoCalibration();

        consecutiveFailedDetections = 0;

        requestAnimationFrame(updatePitch);
      } catch (error) {
        console.error('マイクへのアクセスエラー:', error);
        updateStatus('マイクへのアクセスができませんでした。', true);
      }
    }

    function stopListening() {
      if (microphone) {
        microphone.disconnect();
        microphone = null;
      }

      if (analyser) {
        analyser.disconnect();
        analyser = null;
      }

      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }

      isListening = false;
      startButton.textContent = 'マイクをオン';
      startButton.classList.remove('active');
      startButton.setAttribute('aria-pressed', 'false');
      startButton.setAttribute('aria-label', 'マイク入力でチューニングを開始');

      noteDisplay.textContent = '--';
      noteDisplay.style.color = 'var(--text-color)';
      octaveDisplay.textContent = '';
      frequencyDisplay.textContent = '0 Hz';
      centsDisplay.textContent = '';
      meterNeedle.style.left = '50%';
      meterContainer.setAttribute('aria-valuenow', '0');
      tunerLive.textContent = '';
      lastAnnouncedTuning = '';

      waveformCtx.clearRect(0, 0, WAVEFORM_LAYOUT_WIDTH, WAVEFORM_LAYOUT_HEIGHT);

      updateStatus('マイクがオフになりました。');
    }

    function toggleMetronome() {
      if (isMetronomeActive) {
        stopMetronome();
      } else {
        startMetronome();
      }
    }

    function startMetronome() {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      isMetronomeActive = true;
      metronomeButton.textContent = 'メトロノーム停止';
      metronomeButton.classList.add('active');
      metronomeButton.setAttribute('aria-pressed', 'true');
      metronomeButton.setAttribute('aria-label', 'メトロノームを停止');

      const clickInterval = 1000;

      playMetronomeClick();

      metronomeInterval = setInterval(() => {
        playMetronomeClick();
      }, clickInterval);

      updateStatus('メトロノーム: 60 BPM');
    }

    function stopMetronome() {
      if (metronomeInterval) {
        clearInterval(metronomeInterval);
        metronomeInterval = null;
      }

      isMetronomeActive = false;
      metronomeButton.textContent = 'メトロノーム';
      metronomeButton.classList.remove('active');
      metronomeButton.setAttribute('aria-pressed', 'false');
      metronomeButton.setAttribute('aria-label', 'メトロノーム 60 BPM');

      updateStatus('メトロノームが停止しました。');
    }

    function playMetronomeClick() {
      const clickOscillator = audioContext.createOscillator();
      const clickGain = audioContext.createGain();

      clickOscillator.type = 'sine';
      clickOscillator.frequency.setValueAtTime(880, audioContext.currentTime);

      clickGain.gain.setValueAtTime(0, audioContext.currentTime);
      clickGain.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.001);
      clickGain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);

      clickOscillator.connect(clickGain);
      clickGain.connect(audioContext.destination);

      clickOscillator.start();
      clickOscillator.stop(audioContext.currentTime + 0.1);
    }

    function preprocessTimeDomainForPitch(buffer) {
      const n = buffer.length;
      const out = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += buffer[i];
      }
      const mean = sum / n;
      const denom = Math.max(1, n - 1);
      for (let i = 0; i < n; i++) {
        const hannWindow = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
        out[i] = (buffer[i] - mean) * hannWindow;
      }
      return out;
    }

    function detectPitchYIN(buffer, sampleRate) {
      const threshold = 0.1;
      const bufferSize = buffer.length;
      const yinBuffer = new Float32Array(bufferSize / 2);

      for (let t = 0; t < yinBuffer.length; t++) {
        yinBuffer[t] = 0;
        for (let i = 0; i < yinBuffer.length; i++) {
          const delta = buffer[i] - buffer[i + t];
          yinBuffer[t] += delta * delta;
        }
      }

      let sum = 0;
      yinBuffer[0] = 1;
      for (let t = 1; t < yinBuffer.length; t++) {
        sum += yinBuffer[t];
        yinBuffer[t] *= t / sum;
      }

      let tau = 0;
      let minVal = 1000;

      for (let t = 2; t < yinBuffer.length; t++) {
        if (yinBuffer[t] < threshold && yinBuffer[t] < yinBuffer[t - 1] && yinBuffer[t] < yinBuffer[t + 1]) {
          if (yinBuffer[t] < minVal) {
            minVal = yinBuffer[t];
            tau = t;
          }
        }
      }

      if (tau === 0 || minVal >= threshold) {
        return -1;
      }

      const betterTau = refinePeriodByParabolicInterpolation(yinBuffer, tau);

      return sampleRate / betterTau;
    }

    function refinePeriodByParabolicInterpolation(yinBuffer, tauEstimate) {
      if (tauEstimate < 1 || tauEstimate >= yinBuffer.length - 1) {
        return tauEstimate;
      }

      const s0 = yinBuffer[tauEstimate - 1];
      const s1 = yinBuffer[tauEstimate];
      const s2 = yinBuffer[tauEstimate + 1];

      const adjustment = (s2 - s0) / (2 * (2 * s1 - s2 - s0));

      return tauEstimate + adjustment;
    }

    function autoCorrelateFromPreprocessed(bufferCopy, sampleRate) {
      const minFrequency = 20;
      const maxFrequency = 500;
      const minSamples = Math.floor(sampleRate / maxFrequency);
      const maxSamples = Math.floor(sampleRate / minFrequency);
      const correlations = new Float32Array(maxSamples - minSamples);

      let rms = 0;
      for (let i = 0; i < bufferCopy.length; i++) {
        rms += bufferCopy[i] * bufferCopy[i];
      }
      rms = Math.sqrt(rms / bufferCopy.length);

      const adjustedNoiseFloor = (noiseFloor * 1.5) / sensitivityMultiplier;

      if (rms < adjustedNoiseFloor) {
        consecutiveFailedDetections++;
        if (consecutiveFailedDetections > MAX_FAILED_DETECTIONS) {
          noteDisplay.textContent = '--';
          noteDisplay.style.color = 'var(--text-color)';
          octaveDisplay.textContent = '';
          frequencyDisplay.textContent = '0 Hz';
          centsDisplay.textContent = '';
          meterNeedle.style.left = '50%';
          meterContainer.setAttribute('aria-valuenow', '0');
        }
        return -1;
      }

      consecutiveFailedDetections = 0;

      for (let lag = minSamples; lag < maxSamples; lag++) {
        let lagSum = 0;
        for (let i = 0; i < bufferCopy.length - lag; i++) {
          lagSum += bufferCopy[i] * bufferCopy[i + lag];
        }
        correlations[lag - minSamples] = lagSum / (bufferCopy.length - lag);
      }

      let startIndex = 0;
      while (startIndex < correlations.length - 1 && correlations[startIndex] > correlations[startIndex + 1]) {
        startIndex++;
      }

      let bestPeriod = 0;
      let bestCorrelation = 0;

      for (let i = startIndex; i < correlations.length; i++) {
        if (correlations[i] > bestCorrelation) {
          bestCorrelation = correlations[i];
          bestPeriod = i;
        }
      }

      let phase = 0;
      if (bestPeriod > 0 && bestPeriod < correlations.length - 1) {
        const leftValue = correlations[bestPeriod - 1];
        const centerValue = correlations[bestPeriod];
        const rightValue = correlations[bestPeriod + 1];

        const delta = rightValue - leftValue;
        const denom = 2 * centerValue - leftValue - rightValue;
        const parabolicAdjustment = delta && denom !== 0 ? 0.5 * delta / denom : 0;
        phase = parabolicAdjustment;
      }

      if (bestCorrelation < 0.3) {
        return -1;
      }

      return sampleRate / (bestPeriod + phase);
    }

    function detectPitch(buffer, sampleRate) {
      const preprocessed = preprocessTimeDomainForPitch(buffer);
      const yinFrequency = detectPitchYIN(preprocessed, sampleRate);

      if (yinFrequency > 0) {
        consecutiveFailedDetections = 0;
        return yinFrequency;
      }

      return autoCorrelateFromPreprocessed(preprocessed, sampleRate);
    }

    function updatePitch() {
      if (!isListening || !analyser) {
        return;
      }

      const bufferLength = analyser.fftSize;
      const buffer = new Float32Array(bufferLength);
      analyser.getFloatTimeDomainData(buffer);

      drawWaveform(buffer);

      const frequency = detectPitch(buffer, audioContext.sampleRate);

      if (frequency > 0) {
        displayNote(frequency);
        frequencyDisplay.textContent = `${frequency.toFixed(2)} Hz`;
      }

      requestAnimationFrame(updatePitch);
    }

    function drawWaveform(buffer) {
      waveformCtx.clearRect(0, 0, WAVEFORM_LAYOUT_WIDTH, WAVEFORM_LAYOUT_HEIGHT);
      waveformCtx.lineWidth = 2;
      waveformCtx.strokeStyle = 'rgba(0, 120, 255, 0.8)';
      waveformCtx.beginPath();

      const sliceWidth = WAVEFORM_LAYOUT_WIDTH / buffer.length;
      let x = 0;

      for (let i = 0; i < buffer.length; i++) {
        const y = (0.5 + buffer[i] * 30 * sensitivityMultiplier) * WAVEFORM_LAYOUT_HEIGHT;

        if (i === 0) {
          waveformCtx.moveTo(x, y);
        } else {
          waveformCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      waveformCtx.stroke();
    }

    function announceTuning(text) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (text === lastAnnouncedTuning && now - lastAnnounceTime < ANNOUNCE_INTERVAL_MS) {
        return;
      }
      lastAnnouncedTuning = text;
      lastAnnounceTime = now;
      tunerLive.textContent = text;
    }

    function displayNote(frequency) {
      const noteStrings = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
      const flatNoteStrings = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

      const referenceA4 = referenceFrequency;
      const referenceA4MidiNote = 69;

      const midiNoteFloat = 12 * Math.log2(frequency / referenceA4) + referenceA4MidiNote;
      const midiNote = Math.round(midiNoteFloat);

      const noteIndex = ((midiNote % 12) + 12) % 12;

      const useSharps = [0, 2, 4, 5, 7, 9, 11].includes(noteIndex);
      const noteName = useSharps ? noteStrings[noteIndex] : flatNoteStrings[noteIndex];

      const octave = Math.floor(midiNote / 12) - 1;

      const noteFrequency = referenceA4 * Math.pow(2, (midiNote - referenceA4MidiNote) / 12);

      const cents = Math.round(1200 * Math.log2(frequency / noteFrequency));

      noteDisplay.textContent = noteName;
      octaveDisplay.textContent = octave;

      const needlePosition = 50 + cents;
      const clampedPosition = Math.max(0, Math.min(100, needlePosition));
      meterNeedle.style.left = `${clampedPosition}%`;

      const clampedAriaCents = Math.max(-50, Math.min(50, cents));
      meterContainer.setAttribute('aria-valuenow', String(clampedAriaCents));

      const centsSign = cents > 0 ? '+' : '';
      centsDisplay.textContent = `${centsSign}${cents} cent`;

      announceTuning(`${noteName}${octave}、${centsSign}${cents} セント、${frequency.toFixed(1)} ヘルツ`);

      if (Math.abs(cents) < 5) {
        noteDisplay.style.color = 'var(--accent-color)';
      } else if (Math.abs(cents) < 15) {
        noteDisplay.style.color = 'var(--primary-color)';
      } else {
        noteDisplay.style.color = 'var(--text-color)';
      }
    }

    function updateStatus(message, isError = false) {
      statusMessage.textContent = message;
      statusMessage.classList.add('visible');

      if (isError) {
        statusMessage.classList.add('error');
      } else {
        statusMessage.classList.remove('error');
      }

      setTimeout(() => {
        statusMessage.classList.remove('visible');
      }, 3000);
    }

    referenceSelect.addEventListener('change', function() {
      referenceFrequency = parseInt(this.value, 10);
      updateReferenceStrings();
      updateStatus(`基準音: A = ${referenceFrequency} Hz`);
    });

    tuningSelect.addEventListener('change', function() {
      updateReferenceStrings();
      updateStatus(`チューニング: ${this.options[this.selectedIndex].text}`);
    });

    startButton.addEventListener('click', function() {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    });

    metronomeButton.addEventListener('click', toggleMetronome);

    sensitivitySlider.addEventListener('input', applySensitivityFromSlider);
    sensitivitySlider.addEventListener('change', applySensitivityFromSlider);

    resizeWaveformCanvas();
    window.addEventListener('resize', resizeWaveformCanvas);

    applySensitivityFromSlider();
    updateReferenceStrings();
  });
