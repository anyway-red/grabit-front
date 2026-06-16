const USER_ID = "test_user";

// --- CRITICAL CONFIGURATION FIXED FOR GITHUB PAGES ---
const BACKEND_NGROK_DOMAIN = "cringing-niece-playpen.ngrok-free.dev";
const httpApiBase = `https://${BACKEND_NGROK_DOMAIN}`;
const wsUrl = `wss://${BACKEND_NGROK_DOMAIN}/api/live-fix`;

// Elements
const videoEl = document.getElementById('camera-feed');
const canvasEl = document.getElementById('hidden-canvas');
const ctx = canvasEl.getContext('2d');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const flipBtn = document.getElementById('flip-btn');
const startScreen = document.getElementById('start-screen');
const callBar = document.getElementById('call-bar');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const tokenDisplay = document.getElementById('token-display');
const errorMsg = document.getElementById('error-message');

// State
let currentFacingMode = 'environment'; // start with back camera
let ws = null;
let mediaStream = null;
let sendInterval = null;

// Audio Systems Split: One for loud playback, one for precise input capture
let playbackAudioContext = null;
let recordAudioContext = null;
let gainNode = null;
let nextAudioStartTime = 0;
let audioInputProcessor = null;
let audioInputSource = null;

async function initAudioSystems() {
    // 1. Setup Playback Pipeline (Forced to 24kHz to match Gemini output)
    if (!playbackAudioContext) {
        playbackAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        gainNode = playbackAudioContext.createGain();
        gainNode.gain.setValueAtTime(3.0, playbackAudioContext.currentTime); // Loud volume boost
        gainNode.connect(playbackAudioContext.destination);
        nextAudioStartTime = playbackAudioContext.currentTime;
    }
    if (playbackAudioContext.state === 'suspended') {
        await playbackAudioContext.resume();
    }

    // 2. Setup Recording Pipeline (Native hardware matching to avoid driver drift)
    if (!recordAudioContext) {
        recordAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (recordAudioContext.state === 'suspended') {
        await recordAudioContext.resume();
    }
}

function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

function playPCM16(buffer) {
    if (!playbackAudioContext || !gainNode) return;

    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = playbackAudioContext.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = playbackAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainNode);

    const currentTime = playbackAudioContext.currentTime;
    if (nextAudioStartTime < currentTime) {
        nextAudioStartTime = currentTime;
    }

    source.start(nextAudioStartTime);
    nextAudioStartTime += audioBuffer.duration;
}

async function fetchBalance() {
    try {
        const res = await fetch(`${httpApiBase}/api/balance/${USER_ID}`, {
            headers: { "ngrok-skip-browser-warning": "true" }
        });
        if (res.ok) {
            const data = await res.json();
            tokenDisplay.innerText = data.balance.toLocaleString();
        }
    } catch (e) {
        console.error("Could not fetch balance", e);
    }
}

async function startSession() {
    errorMsg.style.display = 'none';
    await initAudioSystems();

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: currentFacingMode },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        videoEl.srcObject = mediaStream;

        canvasEl.width = 640;
        canvasEl.height = 480;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            statusIndicator.className = 'status-indicator connected';
            statusText.innerText = 'Connected';
            startScreen.style.display = 'none';
            callBar.style.display = 'flex';

            sendInterval = setInterval(captureAndSendFrame, 500);
            startAudioCapture();
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.error) {
                errorMsg.innerText = msg.error;
                errorMsg.style.display = 'block';
                setTimeout(() => { errorMsg.style.display = 'none'; }, 5000);
                if (msg.error.includes("Refill") || msg.error.includes("tokens")) {
                    stopSession();
                }
            } else if (msg.type === "audio") {
                const arrayBuffer = base64ToArrayBuffer(msg.data);
                playPCM16(arrayBuffer);
            }
            if (Math.random() < 0.2) fetchBalance();
        };

        ws.onclose = () => { stopSession(); };

    } catch (err) {
        console.error("Error starting session", err);
        errorMsg.innerText = "Camera/Mic access denied or WebSocket connection failed.";
        errorMsg.style.display = 'block';
    }
}

function startAudioCapture() {
    audioInputSource = recordAudioContext.createMediaStreamSource(mediaStream);

    // Use a smaller 512 slice buffer size to drastically reduce microphone streaming latency
    audioInputProcessor = recordAudioContext.createScriptProcessor(512, 1, 1);

    const targetSampleRate = 16000; // 16kHz is widely supported by Gemini Live input lines
    const srcSampleRate = recordAudioContext.sampleRate;

    audioInputProcessor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Dynamic Downsampling Logic: Resamples input data on-the-fly to a clean 16kHz layout
        const resampleRatio = srcSampleRate / targetSampleRate;
        const targetLength = Math.round(inputData.length / resampleRatio);
        const int16Buffer = new Int16Array(targetLength);

        for (let i = 0; i < targetLength; i++) {
            const srcIndex = Math.round(i * resampleRatio);
            if (srcIndex < inputData.length) {
                let sample = inputData[srcIndex];
                // Soft ceiling compression clamp
                sample = Math.max(-1, Math.min(1, sample));
                int16Buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }
        }

        const binaryString = String.fromCharCode.apply(null, new Uint8Array(int16Buffer.buffer));
        const base64Audio = window.btoa(binaryString);

        ws.send(JSON.stringify({
            type: "audio",
            data: base64Audio
        }));
    };

    audioInputSource.connect(audioInputProcessor);
    audioInputProcessor.connect(recordAudioContext.destination);
}

function captureAndSendFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.6);
    const b64Data = dataUrl.split(',')[1];

    ws.send(JSON.stringify({
        type: "video",
        data: b64Data
    }));
}

function stopSession() {
    if (sendInterval) clearInterval(sendInterval);

    if (audioInputProcessor && audioInputSource) {
        audioInputProcessor.disconnect();
        audioInputSource.disconnect();
        audioInputProcessor = null;
        audioInputSource = null;
    }

    if (ws) {
        ws.close();
        ws = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        videoEl.srcObject = null;
    }

    statusIndicator.className = 'status-indicator error';
    statusText.innerText = 'Disconnected';
    startScreen.style.display = 'flex';
    callBar.style.display = 'none';

    fetchBalance();
}

async function flipCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    flipBtn.innerText = currentFacingMode === 'environment' ? 'Flip Camera' : 'Flip Camera (Front)';

    // Stop old tracks
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }

    // Disconnect old audio capture
    if (audioInputProcessor && audioInputSource) {
        audioInputProcessor.disconnect();
        audioInputSource.disconnect();
        audioInputProcessor = null;
        audioInputSource = null;
    }

    // Get new stream with opposite camera
    mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: currentFacingMode },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });
    videoEl.srcObject = mediaStream;

    // Restart audio capture on new stream
    startAudioCapture();
}

startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);
flipBtn.addEventListener('click', flipCamera);

fetchBalance();