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
const themeToggle = document.getElementById('theme-toggle');
const historySection = document.getElementById('history-section');
const historyList = document.getElementById('history-list');
const transferSpeed = document.getElementById('transfer-speed');
const transferEta = document.getElementById('transfer-eta');

// Phase 1 Refinement
let speedSamples = [];
const SPEED_SAMPLE_COUNT = 10;
let lastBytes = 0;
let lastTime = 0;

// Phase 2 Elements
const clipboardArea = document.getElementById('clipboard-area');
const copyBtn = document.getElementById('copy-btn');
const notesDisplay = document.getElementById('notes-display');
const noteInput = document.getElementById('note-input');
const sendNoteBtn = document.getElementById('send-note-btn');
const installBtn = document.getElementById('install-btn');
const testNotifBtn = document.getElementById('test-notif-btn');

let transferStartTime = 0;
let transferHistory = [];
let deferredPrompt;

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


// --- i18n Translations ---
const translations = {
    fr: {
        install_app: "Installer l'App",
        ready: "Prêt à connecter",
        hero_title: "Partagez vos fichiers, simplement.",
        hero_subtitle: "Ultra-rapide. P2P direct. Sans limites.",
        waiting_devices: "En attente d'autres appareils...",
        history_title: "Historique des transferts",
        clear_history: "Effacer",
        clipboard_title: "📋 Presse-papier",
        clipboard_placeholder: "Copiez du texte ici pour le partager...",
        sync_auto: "Sync auto",
        copy: "Copier",
        copied: "Copié !",
        notes_title: "✍️ Notes partagées",
        note_placeholder: "Écrire une note...",
        empty_notes: "Aucun message pour le moment...",
        how_it_works: "Comment ça marche ?",
        step1_title: "Ouvrez ILOVESHARE",
        step1_desc: "Sur deux appareils connectés au même réseau (WiFi ou 4G/5G).",
        step2_title: "Scannez le QR Code",
        step2_desc: "Utilisez votre téléphone pour scanner le code affiché sur votre PC.",
        step3_title: "Partagez en direct",
        step3_desc: "Sélectionnez vos fichiers. Ils sont envoyés sans passer par le cloud.",
        status_sending: "Envoi de {name}...",
        status_receiving: "Réception de {name}...",
        status_sent: "Envoi terminé !",
        status_received: "Réception terminée !",
        status_error: "Erreur lors du transfert.",
        status_zipping: "Compression en cours...",
        status_ready: "Prêt",
        btn_file: "Fichier",
        btn_folder: "Dossier",
        notif_sent: "Transfert réussi !",
        notif_sent_body: "Le fichier {name} a été envoyé.",
        notif_received: "Fichier reçu !",
        notif_new_message: "Nouveau message !",
        notif_test_title: "Test Réussi !",
        notif_test_body: "Ceci est un exemple de notification ILOVESHARE.",
        notif_thanks: "Merci !",
        notif_enabled: "Les notifications sont maintenant activées."
    },
    en: {
        install_app: "Install App",
        ready: "Ready to connect",
        hero_title: "Share your files, simply.",
        hero_subtitle: "Ultra-fast. Direct P2P. No limits.",
        waiting_devices: "Waiting for other devices...",
        history_title: "Transfer History",
        clear_history: "Clear",
        clipboard_title: "📋 Shared Clipboard",
        clipboard_placeholder: "Paste text here to share...",
        sync_auto: "Auto sync",
        copy: "Copy",
        copied: "Copied!",
        notes_title: "✍️ Shared Notes",
        note_placeholder: "Write a note...",
        empty_notes: "No messages yet...",
        how_it_works: "How it works?",
        step1_title: "Open ILOVESHARE",
        step1_desc: "On two devices connected to the same network (WiFi or 4G/5G).",
        step2_title: "Scan QR Code",
        step2_desc: "Use your phone to scan the code displayed on your PC.",
        step3_title: "Share Live",
        step3_desc: "Select your files. They are sent without going through the cloud.",
        status_sending: "Sending {name}...",
        status_receiving: "Receiving {name}...",
        status_sent: "Sent successfully!",
        status_received: "Received successfully!",
        status_error: "Transfer error.",
        status_zipping: "Zipping folder...",
        status_ready: "Ready",
        btn_file: "File",
        btn_folder: "Folder",
        notif_sent: "Transfer successful!",
        notif_sent_body: "The file {name} has been sent.",
        notif_received: "File received!",
        notif_new_message: "New message!",
        notif_test_title: "Test Successful!",
        notif_test_body: "This is an ILOVESHARE notification example.",
        notif_thanks: "Thank you!",
        notif_enabled: "Notifications are now enabled."
    },
    de: {
        install_app: "App installieren",
        ready: "Bereit zum Verbinden",
        hero_title: "Dateien teilen, ganz einfach.",
        hero_subtitle: "Ultraschnell. Direktes P2P. Keine Grenzen.",
        waiting_devices: "Warten auf andere Geräte...",
        history_title: "Übertragungsverlauf",
        clear_history: "Löschen",
        clipboard_title: "📋 Zwischenablage",
        clipboard_placeholder: "Text hier einfügen, um ihn zu teilen...",
        sync_auto: "Auto-Sync",
        copy: "Kopieren",
        copied: "Kopiert!",
        notes_title: "✍️ Geteilte Notizen",
        note_placeholder: "Notiz schreiben...",
        empty_notes: "Noch keine Nachrichten...",
        how_it_works: "Wie funktioniert es?",
        step1_title: "ILOVESHARE öffnen",
        step1_desc: "Auf zwei Geräten im selben Netzwerk (WLAN oder 4G/5G).",
        step2_title: "QR-Code scannen",
        step2_desc: "Scannen Sie den auf Ihrem PC angezeigten Code mit Ihrem Handy.",
        step3_title: "Live teilen",
        step3_desc: "Wählen Sie Ihre Dateien aus. Sie werden ohne Cloud-Umweg gesendet.",
        status_sending: "Sende {name}...",
        status_receiving: "Empfange {name}...",
        status_sent: "Erfolgreich gesendet!",
        status_received: "Erfolgreich empfangen!",
        status_error: "Übertragungsfehler.",
        status_zipping: "Ordner wird komprimiert...",
        status_ready: "Bereit",
        btn_file: "Datei",
        btn_folder: "Ordner",
        notif_sent: "Übertragung erfolgreich!",
        notif_sent_body: "Die Datei {name} wurde gesendet.",
        notif_received: "Datei empfangen!",
        notif_new_message: "Neue Nachricht!",
        notif_test_title: "Test erfolgreich!",
        notif_test_body: "Dies ist ein Beispiel für eine ILOVESHARE-Benachrichtigung.",
        notif_thanks: "Vielen Dank!",
        notif_enabled: "Benachrichtigungen sind jetzt aktiviert."
    }
};

let currentLang = localStorage.getItem('iloveshare_lang') || 'fr';

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('iloveshare_lang', lang);
    updateUI();
}

function updateUI() {
    const t = translations[currentLang];

    // Update text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.innerText = t[key];
    });

    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });

    // Update language switcher UI
    const flags = { fr: '🇫🇷', en: '🇺🇸', de: '🇩🇪' };
    const names = { fr: 'FR', en: 'EN', de: 'DE' };
    const currentLangFlagEl = document.getElementById('current-lang-flag');
    const currentLangNameEl = document.getElementById('current-lang-name');
    if (currentLangFlagEl) currentLangFlagEl.innerText = flags[currentLang];
    if (currentLangNameEl) currentLangNameEl.innerText = names[currentLang];

    // Highlight active option
    document.querySelectorAll('.lang-option').forEach(opt => {
        opt.classList.toggle('active', opt.id === `lang-${currentLang}`);
    });
}

// Initial UI update
document.addEventListener('DOMContentLoaded', updateUI);

// Global access for onclick handlers
window.setLanguage = setLanguage;


// --- Socket.io Events ---

// --- Theme Management ---
let currentTheme = localStorage.getItem('iloveshare_theme') || 'light';
document.documentElement.setAttribute('data-theme', currentTheme);

themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('iloveshare_theme', currentTheme);
});

// --- PWA & Notifications (Phase 3) ---

// Service Worker Registration
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(() => console.log('Service Worker Registered'));
}

// Installation Prompt
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            installBtn.classList.add('hidden');
        }
        deferredPrompt = null;
    }
});

// Notifications
function requestNotificationPermission() {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                console.log('Notifications authorized');
            }
        });
    }
}

testNotifBtn.addEventListener('click', () => {
    if (!('Notification' in window)) {
        alert("Votre navigateur ne supporte pas les notifications.");
        return;
    }

    const t = translations[currentLang];
    if (Notification.permission === 'granted') {
        showNotification(t.notif_test_title, t.notif_test_body);
    } else {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                showNotification(t.notif_thanks, t.notif_enabled);
            } else {
                alert("Vous avez désactivé les notifications. Veuillez les réactiver dans les paramètres de votre navigateur.");
            }
        });
    }
});

function showNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const options = {
                body: body,
                icon: '/favicon.png',
                badge: '/favicon.png',
                vibrate: [200, 100, 200]
            };

            // Try Service Worker notification first (works better in background/standalone)
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(registration => {
                    registration.showNotification(title, options);
                });
            } else {
                new Notification(title, options);
            }
        } catch (e) {
            console.error('Notification error:', e);
        }
    }
}

// Request permission on first interaction or connect
socket.on('connect', () => {
    requestNotificationPermission();
    myId = socket.id;
    console.log('Connected, Socket ID:', myId, 'Client ID:', clientId);

    // Join the room
    if (roomId) {
        // --- Communication & Magic Logic (Phase 2) ---

        // Shared Clipboard
        clipboardArea.addEventListener('input', () => {
            broadcastMessage({
                type: 'clipboard',
                text: clipboardArea.value
            });
        });

        copyBtn.addEventListener('click', () => {
            clipboardArea.select();
            document.execCommand('copy');
            const t = translations[currentLang];
            copyBtn.innerText = t.copied;
            setTimeout(() => copyBtn.innerText = t.copy, 2000);
        });

        // Direct Notes
        sendNoteBtn.addEventListener('click', sendNote);
        noteInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendNote();
        });

        function sendNote() {
            const text = noteInput.value.trim();
            if (!text) return;

            broadcastMessage({
                type: 'note',
                text: text
            });

            displayNote(text, true);
            noteInput.value = '';
        }

        function displayNote(text, isSelf) {
            const emptyMsg = notesDisplay.querySelector('.empty-notes');
            if (emptyMsg) emptyMsg.remove();

            const note = document.createElement('div');
            note.className = `note-item ${isSelf ? 'self' : ''}`;
            note.innerText = text;
            notesDisplay.appendChild(note);
            notesDisplay.scrollTop = notesDisplay.scrollHeight;
        }

        function broadcastMessage(data) {
            // Send to all open data channels
            for (const id in peerConnections) {
                const dc = dataChannels[id];
                if (dc && dc.readyState === 'open') {
                    dc.send(JSON.stringify(data));
                }
            }
        }

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
        const t = translations[currentLang];
        showStatus(t.status_zipping);
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
            showStatus(t.status_error);
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
    const t = translations[currentLang];

    // Filter out self
    const peers = users.filter(u => u.clientId !== clientId);

    if (peers.length === 0) {
        deviceList.innerHTML = `
            <div class="empty-state">
                <div class="loader-ring"></div>
                <p data-i18n="waiting_devices">${t.waiting_devices}</p>
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
                <button class="action-btn" onclick="onFileSelect('${user.id}')" data-i18n="btn_file">${t.btn_file}</button>
                <button class="action-btn folder-btn" onclick="onFolderSelect('${user.id}')" data-i18n="btn_folder">${t.btn_folder}</button>
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
            const t = translations[currentLang];
            showStatus(t.status_connection_failed || "Connection Failed - Retrying..."); // Assuming a new translation key
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
    const t = translations[currentLang];
    showStatus(t.status_sending.replace('{name}', file.name));

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
    transferStartTime = Date.now();

    const readNextChunk = () => {
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

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
                    showStatus(t.status_sent);
                    addToHistory(file.name, file.size, 'sent');
                    showNotification(t.notif_sent, t.notif_sent_body.replace('{name}', file.name));
                }
            } catch (err) {
                console.error("Transfer Error:", err);
                showStatus(translations[currentLang].status_error);
            }
        };

        reader.onerror = (err) => {
            console.error("FileReader Error:", err);
            showStatus(translations[currentLang].status_error);
        };

        reader.readAsArrayBuffer(chunk);
    };

    readNextChunk();
}

// --- File Transfer Logic (Receiver) ---

function handleReceiveMessage(event) {
    const data = event.data;
    const t = translations[currentLang];

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
            transferStartTime = Date.now();
            lastBytes = 0;
            lastTime = Date.now();
            speedSamples = [];

            showStatus(t.status_receiving.replace('{name}', currentFileName));
        } else if (message.type === 'eof') {
            const blob = downloadFile();
            addToHistory(currentFileName, totalSize, 'received', blob);
            showNotification(t.notif_received, currentFileName);
        } else if (message.type === 'clipboard') {
            clipboardArea.value = message.text;
        } else if (message.type === 'note') {
            displayNote(message.text, false);
            // Optionally notify user for high visibility
            if (document.hidden) {
                showNotification(t.notif_new_message, message.text);
            }
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

    // Cleanup for auto-download
    document.body.removeChild(a);
    // Note: We keep the ObjectURL if we want re-downloads, but Blobs are better for memory.
    // URL.revokeObjectURL(url); 

    receivedChunks = [];
    isReceiving = false;
    const t = translations[currentLang];
    showStatus(t.status_received);
    setTimeout(() => {
        transferOverlay.classList.add('hidden');
    }, 3000);

    return blob;
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

// --- Helpers ---

function updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    progressBar.style.width = percent + '%';
    transferPercent.innerText = percent + '%';

    // Advanced Speed & ETA Calculation (Rolling Average)
    const now = Date.now();
    const timeDiff = (now - lastTime) / 1000;

    if (timeDiff >= 0.5 || current === total) { // Sample every 0.5s
        const bytesDiff = current - lastBytes;
        const instantSpeed = bytesDiff / timeDiff;

        speedSamples.push(instantSpeed);
        if (speedSamples.length > SPEED_SAMPLE_COUNT) speedSamples.shift();

        const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        const speedMbps = (avgSpeed / (1024 * 1024)).toFixed(2);
        transferSpeed.innerText = `${speedMbps} MB/s`;

        const remainingBytes = total - current;
        const etaSeconds = avgSpeed > 0 ? Math.round(remainingBytes / avgSpeed) : 0;

        if (etaSeconds > 3600) {
            transferEta.innerText = currentLang === 'fr' ? "> 1 heure" : (currentLang === 'de' ? "> 1 Stunde" : "> 1 hour");
        } else if (etaSeconds > 60) {
            const mins = Math.floor(etaSeconds / 60);
            const secs = etaSeconds % 60;
            const t = translations[currentLang];
            const minStr = currentLang === 'fr' ? 'm' : (currentLang === 'de' ? 'm' : 'm');
            const secStr = currentLang === 'fr' ? 's restants' : (currentLang === 'de' ? 's übrig' : 's left');
            transferEta.innerText = `${mins}${minStr} ${secs}${secStr}`;
        } else {
            const secStr = currentLang === 'fr' ? 's restants' : (currentLang === 'de' ? 's übrig' : 's left');
            transferEta.innerText = `${etaSeconds}${secStr}`;
        }

        lastBytes = current;
        lastTime = now;
    }

    const t = translations[currentLang];
    if (isReceiving) {
        statusText.innerText = (currentLang === 'fr' ? 'Réception... ' : (currentLang === 'de' ? 'Empfangen... ' : 'Receiving... ')) + percent + '%';
    } else {
        statusText.innerText = (currentLang === 'fr' ? 'Envoi... ' : (currentLang === 'de' ? 'Senden... ' : 'Sending... ')) + percent + '%';
    }
}

function addToHistory(name, size, type, blob = null) {
    const item = {
        id: Math.random().toString(36).substr(2, 9),
        name,
        size: formatBytes(size),
        type, // 'sent' or 'received'
        time: new Date().toLocaleTimeString(),
        blob // Keep blob for re-download
    };
    transferHistory.unshift(item); // Add to start
    updateHistoryUI();
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function updateHistoryUI() {
    if (transferHistory.length > 0) {
        historySection.classList.remove('hidden');
    }
    const t = translations[currentLang];
    historyList.innerHTML = transferHistory.map(item => `
        <div class="history-item">
            <div class="history-info">
                <span class="history-icon">${item.type === 'sent' ? '📤' : '📥'}</span>
                <div>
                    <div class="history-name">${item.name}</div>
                    <div class="history-size">${item.size} • ${item.time}</div>
                </div>
            </div>
            <div class="history-actions">
                ${item.blob ? `<button class="action-btn small" onclick="downloadHistoryItem('${item.id}')">💾 ${currentLang === 'fr' ? 'Télécharger' : (currentLang === 'de' ? 'Herunterladen' : 'Download')}</button>` : `✅ ${currentLang === 'fr' ? 'Envoyé' : (currentLang === 'de' ? 'Gesendet' : 'Sent')}`}
            </div>
        </div>
    `).join('');
}

window.downloadHistoryItem = (id) => {
    const item = transferHistory.find(h => h.id === id);
    if (item && item.blob) {
        downloadBlob(item.blob, item.name);
    }
};

window.clearHistory = () => {
    transferHistory = [];
    historySection.classList.add('hidden');
};

function showStatus(msg) {
    transferOverlay.classList.remove('hidden');
    statusText.innerText = msg;
    progressBar.style.width = '0%';
    transferSpeed.innerText = '0 MB/s';
    if (window.pendingFile) {
        transferFilename.innerText = window.pendingFile.name;
    } else if (currentFileName) {
        transferFilename.innerText = currentFileName;
    }
}
