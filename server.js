const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Store users per room: roomId -> { socketId: { id, deviceType, clientId } }
let rooms = {};

io.on('connection', (socket) => {
    const clientId = socket.handshake.auth.clientId;
    console.log(`User connected: ${socket.id} (Client: ${clientId})`);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`Socket ${socket.id} joined room ${roomId}`);

        const deviceType = socket.handshake.headers['user-agent'].match(/Mobile/i) ? 'Mobile' : 'PC';

        if (!rooms[roomId]) {
            rooms[roomId] = {};
        }

        // GHOST FIX: Remove any existing connection with same clientId
        // The previous socket might have 'disconnected' poorly
        for (const existingSocketId in rooms[roomId]) {
            if (rooms[roomId][existingSocketId].clientId === clientId) {
                console.log(`Removing ghost socket ${existingSocketId} for client ${clientId}`);
                delete rooms[roomId][existingSocketId];
                // Optional: Force disconnect the old socket if possible? 
                // io.sockets.sockets.get(existingSocketId)?.disconnect();
            }
        }

        // Add new connection
        rooms[roomId][socket.id] = {
            id: socket.id,
            deviceType: deviceType,
            clientId: clientId
        };

        // Notify others
        io.to(roomId).emit('user-list', Object.values(rooms[roomId]));

        socket.emit('joined', { room: roomId });
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Cleanup
        for (const roomId in rooms) {
            if (rooms[roomId][socket.id]) {
                delete rooms[roomId][socket.id];
                io.to(roomId).emit('user-list', Object.values(rooms[roomId]));
                if (Object.keys(rooms[roomId]).length === 0) {
                    delete rooms[roomId];
                }
                break;
            }
        }
    });

    // Signaling (Pass-through with verification)
    socket.on('offer', (data) => {
        // data = { to, offer }
        io.to(data.to).emit('offer', { from: socket.id, offer: data.offer });
    });

    socket.on('answer', (data) => {
        io.to(data.to).emit('answer', { from: socket.id, answer: data.answer });
    });

    socket.on('ice-candidate', (data) => {
        io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
    });
});


http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
