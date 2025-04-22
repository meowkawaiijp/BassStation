document.addEventListener('DOMContentLoaded', function() {
    // DOM要素
    const noteDisplay = document.querySelector('.note-display');
    const octaveDisplay = document.querySelector('.octave-display');
    const frequencyDisplay = document.querySelector('.frequency-display');
    const meterNeedle = document.querySelector('.meter-needle');
    const startButton = document.getElementById('start-button');
    const metronomeButton = document.getElementById('metronome-button');
    const tuningSelect = document.getElementById('tuning-select');
    const referenceSelect = document.getElementById('reference-select');
    const referenceStringsContainer = document.querySelector('.reference-strings');
    const statusMessage = document.getElementById('status-message');
    const sensitivitySlider = document.getElementById('sensitivity-slider');
    const sensitivityValue = document.getElementById('sensitivity-value');
    const waveformCanvas = document.getElementById('waveform-canvas');
    const waveformCtx = waveformCanvas.getContext('2d');
    
    // キャンバスサイズ設定
    waveformCanvas.width = 400;
    waveformCanvas.height = 100;
    
    // アプリケーション状態
    let isListening = false;
    let isMetronomeActive = false;
    let audioContext = null;
    let analyser = null;
    let microphone = null;
    let metronomeInterval = null;
    let referenceFrequency = 440;
    let sensitivityMultiplier = 1.0;
    let noiseFloor = 0.005; // ノイズフロアの初期値
    let calibrationInProgress = false;
    let consecutiveFailedDetections = 0;
    const MAX_FAILED_DETECTIONS = 10;
    
    // チューニングプリセット
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
    
    // 文字列参照ボタンを更新
    function updateReferenceStrings() {
      referenceStringsContainer.innerHTML = '';
      const currentTuning = tunings[tuningSelect.value];
      
      currentTuning.forEach((string, index) => {
        const stringButton = document.createElement('div');
        stringButton.classList.add('string-button');
        stringButton.textContent = `${string.note}${string.octave}`;
        stringButton.dataset.frequency = string.frequency * (referenceFrequency / 440);
        stringButton.dataset.note = string.note;
        stringButton.dataset.octave = string.octave;
        
        stringButton.addEventListener('click', function() {
          playReferenceNote(string.note, string.octave, string.frequency * (referenceFrequency / 440));
          highlightReferenceButton(this);
        });
        
        referenceStringsContainer.appendChild(stringButton);
      });
    }
    
    // 参照ノートを再生
    function playReferenceNote(note, octave, frequency) {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.7, audioContext.currentTime + 0.1); // 音量を上げる
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.start();
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 2);
      oscillator.stop(audioContext.currentTime + 2.1);
      
      // 表示を更新
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
        }
      }, 2100);
    }
    
    // 参照ボタンをハイライト表示
    function highlightReferenceButton(button) {
      const buttons = document.querySelectorAll('.string-button');
      buttons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      setTimeout(() => {
        button.classList.remove('active');
      }, 2000);
    }
    
    // 自動キャリブレーション実行
    async function performAutoCalibration() {
      if (!analyser || calibrationInProgress) return;
      
      calibrationInProgress = true;
      updateStatus('環境音のキャリブレーション中...');
      
      // サンプル数を増やす
      const samples = 20; // 元は10
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
        
        // サンプル間で少し待つ
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      noiseFloor = (totalNoise / samples) * 2.5; // 平均値の2.5倍をノイズフロアに設定
      console.log(`環境音のノイズフロア: ${noiseFloor}`);
      updateStatus(`環境音のキャリブレーション完了`);
      calibrationInProgress = false;
    }
    
    // マイクを起動してリスニングを開始
    async function startListening() {
      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // AudioContextが suspended状態の場合に再開
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        
        // 詳細オプションでマイク入力を取得
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
          }
        });
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096; // より高い解像度
        analyser.smoothingTimeConstant = 0.8; // スムージングを調整
        
        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);
        
        isListening = true;
        startButton.textContent = 'マイクをオフ';
        startButton.classList.add('active');
        
        updateStatus('マイクがアクティブです。音を出してください。');
        
        // 環境音のキャリブレーション
        await performAutoCalibration();
        
        // 初期化
        consecutiveFailedDetections = 0;
        
        requestAnimationFrame(updatePitch);
      } catch (error) {
        console.error('マイクへのアクセスエラー:', error);
        updateStatus('マイクへのアクセスができませんでした。', true);
      }
    }
    
    // リスニングを停止
    function stopListening() {
      if (microphone) {
        microphone.disconnect();
        microphone = null;
      }
      
      if (analyser) {
        analyser.disconnect();
        analyser = null;
      }
      
      isListening = false;
      startButton.textContent = 'マイクをオン';
      startButton.classList.remove('active');
      
      noteDisplay.textContent = '--';
      noteDisplay.style.color = 'var(--text-color)';
      octaveDisplay.textContent = '';
      frequencyDisplay.textContent = '0 Hz';
      meterNeedle.style.left = '50%';
      
      // キャンバスをクリア
      waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
      
      updateStatus('マイクがオフになりました。');
    }
    
    // メトロノームを切り替え
    function toggleMetronome() {
      if (isMetronomeActive) {
        stopMetronome();
      } else {
        startMetronome();
      }
    }
    
    // メトロノームを開始
    function startMetronome() {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      isMetronomeActive = true;
      metronomeButton.textContent = 'メトロノーム停止';
      metronomeButton.classList.add('active');
      
      // 60 BPMで開始（毎秒1回のクリック）
      const clickInterval = 1000; // ミリ秒単位
      
      // 初回のクリックを直ちに再生
      playMetronomeClick();
      
      metronomeInterval = setInterval(() => {
        playMetronomeClick();
      }, clickInterval);
      
      updateStatus('メトロノーム: 60 BPM');
    }
    
    // メトロノームを停止
    function stopMetronome() {
      if (metronomeInterval) {
        clearInterval(metronomeInterval);
        metronomeInterval = null;
      }
      
      isMetronomeActive = false;
      metronomeButton.textContent = 'メトロノーム';
      metronomeButton.classList.remove('active');
      
      updateStatus('メトロノームが停止しました。');
    }
    
    // メトロノームのクリック音を再生
    function playMetronomeClick() {
      const clickOscillator = audioContext.createOscillator();
      const clickGain = audioContext.createGain();
      
      clickOscillator.type = 'sine';
      clickOscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      
      clickGain.gain.setValueAtTime(0, audioContext.currentTime);
      clickGain.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.001); // 音量を上げる
      clickGain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
      
      clickOscillator.connect(clickGain);
      clickGain.connect(audioContext.destination);
      
      clickOscillator.start();
      clickOscillator.stop(audioContext.currentTime + 0.1);
    }
    
    // YIN アルゴリズムを使用したピッチ検出
    function detectPitchYIN(buffer, sampleRate) {
      const threshold = 0.1; // YINアルゴリズムの閾値
      const bufferSize = buffer.length;
      const yinBuffer = new Float32Array(bufferSize / 2);
      
      // YINアルゴリズムステップ1: 自己相関関数
      for (let t = 0; t < yinBuffer.length; t++) {
        yinBuffer[t] = 0;
        for (let i = 0; i < yinBuffer.length; i++) {
          const delta = buffer[i] - buffer[i + t];
          yinBuffer[t] += delta * delta;
        }
      }
      
      // YINアルゴリズムステップ2: 累積平均正規化
      let sum = 0;
      yinBuffer[0] = 1;
      for (let t = 1; t < yinBuffer.length; t++) {
        sum += yinBuffer[t];
        yinBuffer[t] *= t / sum;
      }
      
      // YINアルゴリズムステップ3: 閾値による絶対最小値の検出
      let tau = 0;
      let minVal = 1000; // 非常に大きい値で初期化
      
      for (let t = 2; t < yinBuffer.length; t++) {
        if (yinBuffer[t] < threshold && yinBuffer[t] < yinBuffer[t-1] && yinBuffer[t] < yinBuffer[t+1]) {
          if (yinBuffer[t] < minVal) {
            minVal = yinBuffer[t];
            tau = t;
          }
        }
      }
      
      // 検出失敗の場合
      if (tau === 0 || minVal >= threshold) {
        return -1;
      }
      
      // 放物線補間による精密化
      const betterTau = refinePeriodByParabolicInterpolation(yinBuffer, tau);
      
      return sampleRate / betterTau;
    }
    
    // 放物線補間による周期の精密化
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
    
    // オートコリレーションを使用してピッチを検出
    function autoCorrelate(buffer, sampleRate) {
      // バッファの準備（センタリングと窓関数の適用）
      const bufferCopy = new Float32Array(buffer.length);
      let sum = 0;
      
      // DCオフセットを削除
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i];
      }
      
      const mean = sum / buffer.length;
      
      // ハニング窓を適用してセンタリング
      for (let i = 0; i < buffer.length; i++) {
        // ハニング窓: 0.5 * (1 - cos(2π * i / (N-1)))
        const hannWindow = 0.5 * (1 - Math.cos(2 * Math.PI * i / (buffer.length - 1)));
        bufferCopy[i] = (buffer[i] - mean) * hannWindow;
      }
      
      // 最低検出周波数（20Hz程度に設定、ベースB0の周波数は約31Hz）
      const minFrequency = 20; // ベースの最低音は約31Hz
      const maxFrequency = 500; // ベースの最高音はおよそ500Hz程度
      const minSamples = Math.floor(sampleRate / maxFrequency);
      const maxSamples = Math.floor(sampleRate / minFrequency);
      const correlations = new Float32Array(maxSamples - minSamples);
      
      // RMS（平均二乗平方根）を計算して信号強度を確認
      let rms = 0;
      for (let i = 0; i < bufferCopy.length; i++) {
        rms += bufferCopy[i] * bufferCopy[i];
      }
      rms = Math.sqrt(rms / bufferCopy.length);
      
      // 感度調整を適用
      // 調整係数を大きくする
      const adjustedNoiseFloor = noiseFloor * 1.5 / sensitivityMultiplier; // 元は noiseFloor / sensitivityMultiplier
      
      // 信号が弱すぎる場合は終了
      if (rms < adjustedNoiseFloor) {
        consecutiveFailedDetections++;
        if (consecutiveFailedDetections > MAX_FAILED_DETECTIONS) {
          // 音が検出されない状態が続く場合は表示をリセット
          noteDisplay.textContent = '--';
          noteDisplay.style.color = 'var(--text-color)';
          octaveDisplay.textContent = '';
          frequencyDisplay.textContent = '0 Hz';
          meterNeedle.style.left = '50%';
        }
        return -1;
      }
      
      // 連続検出失敗カウンタをリセット
      consecutiveFailedDetections = 0;
      
      // 自己相関を計算
      for (let lag = minSamples; lag < maxSamples; lag++) {
        let sum = 0;
        for (let i = 0; i < bufferCopy.length - lag; i++) {
          sum += bufferCopy[i] * bufferCopy[i + lag];
        }
        correlations[lag - minSamples] = sum / (bufferCopy.length - lag);
      }
      
      // 最初のピークをスキップ（遅延0の自己相関は常に最大）
      let startIndex = 0;
      while (startIndex < correlations.length && correlations[startIndex] > correlations[startIndex + 1]) {
        startIndex++;
      }
      
      // 最大相関を検索
      let bestPeriod = 0;
      let bestCorrelation = 0;
      
      for (let i = startIndex; i < correlations.length; i++) {
        if (correlations[i] > bestCorrelation) {
          bestCorrelation = correlations[i];
          bestPeriod = i;
        }
      }
      
      // 放物線補間で精度を向上
      let phase = 0;
      if (bestPeriod > 0 && bestPeriod < correlations.length - 1) {
        const leftValue = correlations[bestPeriod - 1];
        const centerValue = correlations[bestPeriod];
        const rightValue = correlations[bestPeriod + 1];
        
        const delta = rightValue - leftValue;
        const parabolicAdjustment = delta ? 0.5 * delta / (2 * centerValue - leftValue - rightValue) : 0;
        phase = parabolicAdjustment;
      }
      
      // 結果の検証
      if (bestCorrelation < 0.3) {
        return -1; // 信頼性の低い結果
      }
      
      return sampleRate / (bestPeriod + phase);
    }
    
    // 複数のピッチ検出アルゴリズムを試す
    function detectPitch(buffer, sampleRate) {
      // まずYINアルゴリズムを試す
      const yinFrequency = detectPitchYIN(buffer, sampleRate);
      
      if (yinFrequency > 0) {
        return yinFrequency;
      }
      
      // YINが失敗したら自己相関法を試す
      return autoCorrelate(buffer, sampleRate);
    }
    
    // ピッチを更新して表示
    function updatePitch() {
      if (!isListening || !analyser) {
        return;
      }
      
      const bufferLength = analyser.fftSize;
      const buffer = new Float32Array(bufferLength);
      analyser.getFloatTimeDomainData(buffer);
      
      // 波形を描画
      drawWaveform(buffer);
      
      // 複数のアルゴリズムを試す
      const frequency = detectPitch(buffer, audioContext.sampleRate);
      
      if (frequency > 0) {
        displayNote(frequency);
        frequencyDisplay.textContent = `${frequency.toFixed(2)} Hz`;
      }
      
      requestAnimationFrame(updatePitch);
    }
    
    // 波形を描画
    function drawWaveform(buffer) {
      waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
      waveformCtx.lineWidth = 2;
      waveformCtx.strokeStyle = 'rgba(0, 120, 255, 0.8)';
      waveformCtx.beginPath();
      
      const sliceWidth = waveformCanvas.width / buffer.length;
      let x = 0;
      
      for (let i = 0; i < buffer.length; i++) {
        const y = (buffer[i] * 30 * sensitivityMultiplier + 0.5) * waveformCanvas.height;
        
        if (i === 0) {
          waveformCtx.moveTo(x, y);
        } else {
          waveformCtx.lineTo(x, y);
        }
        
        x += sliceWidth;
      }
      
      waveformCtx.stroke();
    }
    
    // 周波数から音名と差を決定
    function displayNote(frequency) {
      // ノート名とオクターブの配列（シャープとフラットの両方）
      const noteStrings = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
      const flatNoteStrings = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
      
      // 参照A4の周波数とMIDIノート番号
      const referenceA4 = referenceFrequency;
      const referenceA4MidiNote = 69;
      
      // 周波数から最も近いMIDIノート番号を計算
      const midiNoteFloat = 12 * Math.log2(frequency / referenceA4) + referenceA4MidiNote;
      const midiNote = Math.round(midiNoteFloat);
      
      // MIDIノート番号からノート名とオクターブを決定
      const noteIndex = ((midiNote % 12) + 12) % 12; // 負の値を処理
      
      // シャープとフラットのどちらを使うかを判断
      const useSharps = [0, 2, 4, 5, 7, 9, 11].includes(noteIndex);
      const noteName = useSharps ? noteStrings[noteIndex] : flatNoteStrings[noteIndex];
      
      const octave = Math.floor(midiNote / 12) - 1;
      
      // MIDIノート番号に相当する周波数を計算
      const noteFrequency = referenceA4 * Math.pow(2, (midiNote - referenceA4MidiNote) / 12);
      
      // 周波数の差をセント（半音の1/100）で計算
      const cents = Math.round(1200 * Math.log2(frequency / noteFrequency));
      
      // UI更新
      noteDisplay.textContent = noteName;
      octaveDisplay.textContent = octave;
      
      // メーターの針を更新
      // セントの範囲は-50から+50と仮定
      const needlePosition = 50 + cents;
      const clampedPosition = Math.max(0, Math.min(100, needlePosition));
      meterNeedle.style.left = `${clampedPosition}%`;
      
      // チューニングの精度に基づいて色を変更
      if (Math.abs(cents) < 5) {
        noteDisplay.style.color = 'var(--accent-color)';  // ほぼ完全
      } else if (Math.abs(cents) < 15) {
        noteDisplay.style.color = 'var(--primary-color)';  // 近い
      } else {
        noteDisplay.style.color = 'var(--text-color)';  // 離れている
      }
    }
    
    // ステータスメッセージを更新
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
    
    // 基準周波数の変更をリッスン
    referenceSelect.addEventListener('change', function() {
      referenceFrequency = parseInt(this.value);
      updateReferenceStrings();
      updateStatus(`基準音: A = ${referenceFrequency} Hz`);
    });
    
    // チューニングの変更をリッスン
    tuningSelect.addEventListener('change', function() {
      updateReferenceStrings();
      updateStatus(`チューニング: ${this.options[this.selectedIndex].text}`);
    });
    
    // マイクボタンのクリックをリッスン
    startButton.addEventListener('click', function() {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    });
    
    // メトロノームボタンのクリックをリッスン
    metronomeButton.addEventListener('click', toggleMetronome);
    
    // 初期設定
    updateReferenceStrings();
  });