// --- Configuration ---
const DEPLOYED_URL = "https://ilovesharing.vercel.app";
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Persistent Client ID to handle Vercel reconnections without ghosts
let clientId = localStorage.getItem('localdrop_client_id');
if (!clientId) {
    clientId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem('localdrop_client_id', clientId);
}

// Connect with auth data
// Logic: If on localhost, connect to current host (local server).
// If on deployed URL, connect to current host.
// The DEPLOYED_URL is only used for generating the QR code to ensure phones can reach the public signaling server.
const socket = io(undefined, {
    auth: {
        clientId: clientId
    },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

const fileInput = document.getElementById('file-input');
const deviceList = document.getElementById('device-list');
const transferStatus = document.getElementById('transfer-status');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status-text');
const qrContainer = document.getElementById('qr-container');
const urlDisplay = document.getElementById('url-display');

let myId = null;
let roomId = null;
let selectedPeerId = null; // This will now track SOCKET ID
let peerConnection = null;
let dataChannel = null;
let receivedChunks = [];
let receivedSize = 0;
let totalSize = 0;
let currentFileName = '';
let currentFileType = ''; // Added for file type handling
let isReceiving = false;
let iceCandidateQueue = []; // Queue for candidates arriving before remote description

// ICE Server configuration (STUN servers)
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' } // Added another free STUN
    ]
};

// --- Initialization ---

// Check if room ID is in URL
const urlParams = new URLSearchParams(window.location.search);
roomId = urlParams.get('room');

if (roomId) {
    // We are a CLIENT (Scanner)
    console.log('Joining room:', roomId);
    // Join room when socket connects
} else {
    // We are the HOST
    // Generate Room ID
    roomId = generateRoomId();
    console.log('Created room:', roomId);

    // Always generate QR code pointing to Production URL
    // So phone (on 4G/Wifi) goes to the working public server
    const baseUrl = isLocal ? DEPLOYED_URL : window.location.origin;
    const newUrl = baseUrl + '/?room=' + roomId;

    // Only update local URL state if not redirecting (optional)
    if (!isLocal) {
        window.history.pushState({ path: newUrl }, '', newUrl);
    }

    // Show QR Code
    qrContainer.classList.remove('hidden');
    urlDisplay.innerText = newUrl;

    new QRCode(document.getElementById("qrcode"), {
        text: newUrl,
        width: 128,
        height: 128
    });
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}


// --- Socket.io Events ---

socket.on('connect', () => {
    myId = socket.id;
    console.log('Connected, Socket ID:', myId, 'Client ID:', clientId);

    // Join the room
    if (roomId) {
        socket.emit('join-room', roomId);
    }
});

socket.on('joined', (data) => {
    console.log('Successfully joined room:', data.room);
});

socket.on('user-list', (users) => {
    updateDeviceList(users);
});

socket.on('offer', async (data) => {
    // Incoming connection request (Receiver side for signaling)
    console.log("Received Offer from", data.from);
    iceCandidateQueue = []; // Clear queue for new connection

    await createPeerConnection(data.from, false); // false = not initiator
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

    // Process queued candidates
    while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log("Added queued ICE candidate");
        } catch (e) {
            console.error("Error adding queued candidate:", e);
        }
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { to: data.from, answer: answer });
});

socket.on('answer', async (data) => {
    // Answer to our offer (Sender side)
    console.log("Received Answer from", data.from);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));

    // Process queued candidates (rarely needed here but good practice)
    while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log("Added queued ICE candidate");
        } catch (e) {
            console.error("Error adding queued candidate:", e);
        }
    }
});

socket.on('ice-candidate', async (data) => {
    if (peerConnection) {
        if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                console.log("Added ICE candidate immediately");
            } catch (e) {
                console.error("Error adding candidate", e);
            }
        } else {
            console.log("Queueing ICE candidate (RemoteDesc not ready)");
            iceCandidateQueue.push(data.candidate);
        }
    }
});

// --- UI Logic ---
// Handle File Input
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file && selectedPeerId) {
        startFileTransfer(file);
    }
});

// Handle Folder Input
const folderInput = document.getElementById('folder-input');
folderInput.addEventListener('change', async () => {
    if (folderInput.files.length > 0 && selectedPeerId) {
        showStatus('Zipping folder... please wait');
        try {
            const zip = new JSZip();
            // Get folder name from the first file's webkitRelativePath (e.g., "MyFolder/file.txt")
            const folderName = folderInput.files[0].webkitRelativePath.split('/')[0] || "Folder";

            for (let i = 0; i < folderInput.files.length; i++) {
                const file = folderInput.files[i];
                // Use the relative path to maintain structure
                zip.file(file.webkitRelativePath, file);
            }

            const content = await zip.generateAsync({ type: "blob" });
            // Create a fake file object for the blob with the zip name
            const zipFile = new File([content], `${folderName}.zip`, { type: "application/zip" });

            startFileTransfer(zipFile);
        } catch (e) {
            console.error(e);
            showStatus('Error processing folder');
        }
    }
});


function onFileSelect(peerId) {
    selectedPeerId = peerId;
    fileInput.click();
}

function onFolderSelect(peerId) {
    selectedPeerId = peerId;
    folderInput.click();
}

function startFileTransfer(file) {
    window.pendingFile = file;

    // Initiate WebRTC connection if not exists
    if (!peerConnection || peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'closed') {
        createPeerConnection(selectedPeerId, true);
    } else if (dataChannel && dataChannel.readyState === 'open') {
        sendFile(file);
    } else {
        console.log("Waiting for data channel to open...");
    }
}


function updateDeviceList(users) {
    // Clear list
    deviceList.innerHTML = '';

    // Filter out self (by checking clientId)
    const peers = users.filter(u => u.clientId !== clientId);

    if (peers.length > 0) {
        // qrContainer.classList.add('hidden'); // Optional: hide QR when connected
    }

    if (peers.length === 0) {
        if (roomId && window.location.search.includes('room')) { // Check if we are a client in a room
            deviceList.innerHTML = `<p style="text-align:center;">Waiting for host...</p>`;
        }
        return;
    }

    peers.forEach(user => {
        const card = document.createElement('div');
        card.className = 'device-card';
        // Remove global onclick, use buttons
        // card.onclick = () => onDeviceSelect(user.id);

        const icon = user.deviceType === 'Mobile' ? '📱' : '💻';
        // Use server provided name if available, else fallback
        const displayName = user.deviceName || user.deviceType;

        card.innerHTML = `
            <div class="device-icon">${icon}</div>
            <div class="device-name">${displayName}</div>
            <div class="actions">
                <button class="action-btn" onclick="onFileSelect('${user.id}')">File</button>
                <button class="action-btn folder-btn" onclick="onFolderSelect('${user.id}')">Folder</button>
            </div>
        `;
        deviceList.appendChild(card);
    });
}

// --- WebRTC Logic ---

async function createPeerConnection(peerId, isInitiator) {
    if (peerConnection) peerConnection.close();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { to: peerId, candidate: event.candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
    };

    if (!isInitiator) {
        // Receiver waits for data channel
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannel(dataChannel);
        };
    } else {
        // Initiator creates data channel
        dataChannel = peerConnection.createDataChannel("fileTransfer");
        setupDataChannel(dataChannel, window.pendingFile);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer: offer });
    }
}

function setupDataChannel(channel, fileToSend = null) {
    channel.onopen = () => {
        console.log("Data Channel Open");
        if (fileToSend) {
            sendFile(fileToSend);
        }
    };

    channel.onmessage = handleReceiveMessage;
}

// --- File Transfer Logic (Sender) ---

const CHUNK_SIZE = 64 * 1024; // 64KB (Increased for speed)
const MAX_BUFFER_AMOUNT = 16 * 1024 * 1024; // 16MB

async function sendFile(file) {
    showStatus(`Sending ${file.name}...`);

    // Configure backpressure threshold
    dataChannel.bufferedAmountLowThreshold = 1024 * 1024; // 1MB

    // First message: Metadata
    dataChannel.send(JSON.stringify({
        type: 'metadata',
        name: file.name,
        size: file.size,
        fileType: file.type
    }));

    const buffer = await file.arrayBuffer();
    let offset = 0;

    try {
        // Loop to send chunks
        while (offset < buffer.byteLength) {
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);

            // Wait if buffer is full (Backpressure handling - Event Based)
            if (dataChannel.bufferedAmount > MAX_BUFFER_AMOUNT) {
                await new Promise(resolve => {
                    dataChannel.onbufferedamountlow = () => {
                        dataChannel.onbufferedamountlow = null; // Clean up listener
                        resolve();
                    };
                });
            }

            dataChannel.send(chunk);
            offset += chunk.byteLength;
            updateProgress(offset, file.size);
        }

        // Send EOF
        dataChannel.send(JSON.stringify({ type: 'eof' }));
        showStatus('Sent successfully!');
    } catch (err) {
        console.error("Transfer Error:", err);
        showStatus('Error sending file.');
    }
}

// --- File Transfer Logic (Receiver) ---

function handleReceiveMessage(event) {
    const data = event.data;

    // Check if data is string (metadata or EOF) or ArrayBuffer (file data)
    if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (message.type === 'metadata') {
            receivedChunks = [];
            receivedSize = 0;
            totalSize = message.size;
            currentFileName = message.name;
            currentFileType = message.fileType;
            isReceiving = true;
            showStatus(`Receiving ${currentFileName}...`);
        } else if (message.type === 'eof') {
            downloadFile();
        }
    } else {
        // It's a chunk (ArrayBuffer)
        receivedChunks.push(data);
        receivedSize += data.byteLength;
        updateProgress(receivedSize, totalSize);
    }
}

function downloadFile() {
    const blob = new Blob(receivedChunks, { type: currentFileType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFileName;
    document.body.appendChild(a);
    a.click();

    // Cleanup
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    receivedChunks = [];
    isReceiving = false;
    showStatus('Download complete!');
    setTimeout(() => {
        transferStatus.classList.add('hidden');
    }, 3000);
}

// --- Helpers ---

function updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    progressBar.style.width = percent + '%';

    if (isReceiving) {
        statusText.innerText = `Receiving... ${percent}%`;
    } else {
        statusText.innerText = `Sending... ${percent}%`;
    }
}

function showStatus(msg) {
    transferStatus.classList.remove('hidden');
    statusText.innerText = msg;
    progressBar.style.width = '0%';
}
