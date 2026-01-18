const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Persistent Client ID to handle Vercel reconnections without ghosts
let clientId = localStorage.getItem('localdrop_client_id');
if (!clientId) {
    clientId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem('localdrop_client_id', clientId);
}

// Connect with auth data
// Fixed: If we are on Localhost, we usually want to connect to the local server.
// BUT, if we are on a phone scanning a QR code, the phone might not be able to reach 'localhost'.
// However, the browser 'io(origin)' automatically connects to the server that served the page.
const socket = io(window.location.origin, {
    auth: {
        clientId: clientId
    },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

const fileInput = document.getElementById('file-input');
const deviceList = document.getElementById('device-list');
const transferOverlay = document.getElementById('transfer-overlay');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status-text');
const qrSection = document.getElementById('qr-section');
const urlDisplay = document.getElementById('url-display');
const transferFilename = document.getElementById('transfer-filename');
const transferPercent = document.getElementById('transfer-percent');

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
    // Generate Room ID or get from session to allow refreshes
    roomId = sessionStorage.getItem('localdrop_room_id');
    if (!roomId) {
        roomId = generateRoomId();
        sessionStorage.setItem('localdrop_room_id', roomId);
    }
    console.log('Created room:', roomId);

    // QR Code Logic:
    // If we are on localhost, the phone won't be able to reach it.
    // We should probably show a message or use an Ngrok/Localhost.run link, 
    // but for now, let's just make sure the URL displayed is correct.
    const newUrl = window.location.origin + '/?room=' + roomId;

    // Show QR Section
    qrSection.classList.remove('hidden');
    urlDisplay.innerText = newUrl;

    new QRCode(document.getElementById("qrcode"), {
        text: newUrl,
        width: 160,
        height: 160,
        colorDark: "#1A1A1A",
        colorLight: "#ffffff",
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
    console.log("Sending Answer to", data.from);
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
    console.log("Starting file transfer for:", file.name, "to peer:", selectedPeerId);
    window.pendingFile = file;

    // Initiate WebRTC connection if not exists
    if (!peerConnection || peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'closed' || peerConnection.connectionState === 'failed') {
        console.log("Initializing new PeerConnection...");
        createPeerConnection(selectedPeerId, true);
    } else if (dataChannel && dataChannel.readyState === 'open') {
        console.log("DataChannel already open, sending file immediately.");
        sendFile(file);
    } else {
        console.log("Connection exists but DataChannel is not open. State:", dataChannel ? dataChannel.readyState : "N/A");
    }
}


function updateDeviceList(users) {
    // Clear list
    deviceList.innerHTML = '';

    // Filter out self
    const peers = users.filter(u => u.clientId !== clientId);

    if (peers.length === 0) {
        deviceList.innerHTML = `
            <div class="empty-state">
                <div class="loader-ring"></div>
                <p>En attente d'autres appareils sur votre réseau...</p>
            </div>
        `;
        return;
    }

    peers.forEach(user => {
        const card = document.createElement('div');
        card.className = 'device-card';

        const icon = user.deviceType === 'Mobile' ? '📱' : '💻';
        const displayName = user.deviceName || (user.deviceType === 'Mobile' ? 'Smartphone' : 'Ordinateur');

        card.innerHTML = `
            <div class="device-icon">${icon}</div>
            <div class="device-name">${displayName}</div>
            <div class="actions">
                <button class="action-btn" onclick="onFileSelect('${user.id}')">Fichier</button>
                <button class="action-btn folder-btn" onclick="onFolderSelect('${user.id}')">Dossier</button>
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
            console.log("Sending ICE Candidate to", peerId);
            socket.emit('ice-candidate', { to: peerId, candidate: event.candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('PeerConnection State:', peerConnection.connectionState);
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.innerText = `Status: ${peerConnection.connectionState}`;
        }
        if (peerConnection.connectionState === 'failed') {
            console.error("WebRTC Connection Failed. Check STUN/TURN servers or firewall.");
            showStatus("Connection Failed - Retrying...");
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE Connection State:', peerConnection.iceConnectionState);
    };

    peerConnection.onsignalingstatechange = () => {
        console.log('Signaling State:', peerConnection.signalingState);
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
        console.log("Sending Offer to", peerId);
        socket.emit('offer', { to: peerId, offer: offer });
    }
}

function setupDataChannel(channel, fileToSend = null) {
    console.log("Setting up DataChannel:", channel.label);

    channel.onopen = () => {
        console.log("Data Channel Open!");
        if (fileToSend) {
            console.log("Sending pending file...");
            sendFile(fileToSend);
            window.pendingFile = null;
        }
    };

    channel.onclose = () => {
        console.log("Data Channel Closed");
    };

    channel.onerror = (error) => {
        console.error("Data Channel Error:", error);
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

    let offset = 0;

    const readNextChunk = () => {
        const reader = new FileReader();
        const chunk = file.slice(offset, offset + CHUNK_SIZE);

        reader.onload = async (e) => {
            const buffer = e.target.result;

            // Wait if buffer is full (Backpressure handling)
            if (dataChannel.bufferedAmount > MAX_BUFFER_AMOUNT) {
                await new Promise(resolve => {
                    dataChannel.onbufferedamountlow = () => {
                        dataChannel.onbufferedamountlow = null;
                        resolve();
                    };
                });
            }

            try {
                dataChannel.send(buffer);
                offset += buffer.byteLength;
                updateProgress(offset, file.size);

                if (offset < file.size) {
                    readNextChunk();
                } else {
                    // Send EOF
                    dataChannel.send(JSON.stringify({ type: 'eof' }));
                    showStatus('Sent successfully!');
                }
            } catch (err) {
                console.error("Transfer Error:", err);
                showStatus('Error sending file.');
            }
        };

        reader.onerror = (err) => {
            console.error("FileReader Error:", err);
            showStatus('Error reading file.');
        };

        reader.readAsArrayBuffer(chunk);
    };

    readNextChunk();
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
    showStatus('Téléchargement terminé !');
    setTimeout(() => {
        transferOverlay.classList.add('hidden');
    }, 3000);
}

// --- Helpers ---

function updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    progressBar.style.width = percent + '%';
    transferPercent.innerText = percent + '%';

    if (isReceiving) {
        statusText.innerText = `Réception... ${percent}%`;
    } else {
        statusText.innerText = `Envoi... ${percent}%`;
    }
}

function showStatus(msg) {
    transferOverlay.classList.remove('hidden');
    statusText.innerText = msg;
    if (window.pendingFile) {
        transferFilename.innerText = window.pendingFile.name;
    } else if (currentFileName) {
        transferFilename.innerText = currentFileName;
    }
}
