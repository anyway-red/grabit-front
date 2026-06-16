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
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const tokenDisplay = document.getElementById('token-display');
const errorMsg = document.getElementById('error-message');

// State
let ws = null;
let mediaStream = null;
let sendInterval = null;
let audioContext = null;
let gainNode = null;           // Controls loud media output level
let nextAudioStartTime = 0;   // Tracks sequential alignment for 24kHz stream
let audioInputProcessor = null;
let audioInputSource = null;

async function initAudio() {
    if (!audioContext) {
        // Force the Web Audio context exactly to Gemini's native 24000Hz voice output
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

        // Build a dedicated gain stage to boost output volume floor by 250%
        gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(2.5, audioContext.currentTime);
        gainNode.connect(audioContext.destination);

        nextAudioStartTime = audioContext.currentTime;
    }

    // Ensure the hardware subsystem is awake inside the user execution context
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
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

// Scheduled PCM16 Audio playback loop
function playPCM16(buffer) {
    if (!audioContext || !gainNode) return;

    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = audioContext.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Route through our boosted speaker amplifier stage instead of direct destination
    source.connect(gainNode);

    // Dynamic recovery window if network buffering drops behind physical timeline
    const currentTime = audioContext.currentTime;
    if (nextAudioStartTime < currentTime) {
        nextAudioStartTime = currentTime;
    }

    source.start(nextAudioStartTime);
    nextAudioStartTime += audioBuffer.duration; // Advance chronologically
}

async function fetchBalance() {
    try {
        const res = await fetch(`${httpApiBase}/api/balance/${USER_ID}`, {
            headers: {
                "ngrok-skip-browser-warning": "true"
            }
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

    // Fire instantiation inside the clicking thread context to clear browser permissions blocks
    await initAudio();

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
            audio: true
        });
        videoEl.srcObject = mediaStream;

        canvasEl.width = 640;
        canvasEl.height = 480;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            statusIndicator.className = 'status-indicator connected';
            statusText.innerText = 'Connected';
            startBtn.style.display = 'none';
            stopBtn.style.display = 'block';

            // 1. Stream Camera Frames (2 FPS)
            sendInterval = setInterval(captureAndSendFrame, 500);

            // 2. Stream Microphone Input
            startAudioCapture();
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.error) {
                errorMsg.innerText = msg.error;
                errorMsg.style.display = 'block';
                if (msg.error.includes("Refill") || msg.error.includes("tokens")) {
                    stopSession();
                }
            } else if (msg.type === "audio") {
                const arrayBuffer = base64ToArrayBuffer(msg.data);
                playPCM16(arrayBuffer);
            }

            if (Math.random() < 0.2) fetchBalance();
        };

        ws.onclose = () => {
            stopSession();
        };

    } catch (err) {
        console.error("Error starting session", err);
        errorMsg.innerText = "Camera/Mic access denied or WebSocket connection failed.";
        errorMsg.style.display = 'block';
    }
}

function startAudioCapture() {
    audioInputSource = audioContext.createMediaStreamSource(mediaStream);
    audioInputProcessor = audioContext.createScriptProcessor(2048, 1, 1);

    audioInputProcessor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const int16Buffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            int16Buffer[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }

        const binaryString = String.fromCharCode.apply(null, new Uint8Array(int16Buffer.buffer));
        const base64Audio = window.btoa(binaryString);

        ws.send(JSON.stringify({
            type: "audio",
            data: base64Audio
        }));
    };

    audioInputSource.connect(audioInputProcessor);
    audioInputProcessor.connect(audioContext.destination);
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
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';

    fetchBalance();
}

startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);

// Initialize Ledger View
fetchBalance();