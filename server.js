const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

// --- HIGH LEVEL CONFIGURATION ---
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100MB Buffer for High-Res Images
    pingTimeout: 60000,     // Better connection stability
    cors: { origin: "*" }
});

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE INIT (Enhanced Safety) ---
if (!fs.existsSync(DB_FILE)) {
    // Create DB with default structure if missing
    fs.writeFileSync(DB_FILE, JSON.stringify({ messages: [], users: {} }, null, 2));
}

// Helper: Safe Read
function getDB() {
    try { 
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return data ? JSON.parse(data) : { messages: [], users: {} }; 
    } catch (e) { 
        console.error("⚠️ Database Read Error, resetting to empty...");
        return { messages: [], users: {} }; 
    }
}

// Helper: Safe Save with Limit
function saveDB(data) {
    try {
        // Keep only last 150 messages for better performance
        if (data.messages.length > 150) data.messages = data.messages.slice(-150);
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("⚠️ Database Write Error:", e);
    }
}

// --- VIDEO STATE MEMORY ---
let videoState = {
    active: false,
    type: null,
    src: null,
    status: 'paused',
    timestamp: 0,
    lastUpdate: Date.now()
};

// Serve Client
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Track Sockets
let activeSockets = {};

io.on('connection', (socket) => {
    
    // Immediate Online Count Update
    io.emit('update_online_count', io.engine.clientsCount);

    // --- JOIN LOGIC ---
    socket.on('join', (username) => {
        const db = getDB();
        // Validation: Ensure name exists and is trimmed
        let cleanName = (username && typeof username === 'string') ? username.trim().substring(0, 20) : "Anon";
        if(cleanName.length === 0) cleanName = "Anon";

        activeSockets[socket.id] = cleanName;

        // Create Profile if new
        if (!db.users[cleanName]) {
            db.users[cleanName] = {
                name: cleanName,
                avatar: null, // Stores Base64
                color: '#6366F1',
                bio: "Just joined ProChat 3D",
                location: "Unknown"
            };
            saveDB(db);
        }

        // Send Success & Data
        socket.emit('login_success', db.users[cleanName]);
        socket.emit('history', db.messages);

        // Sync Video if active
        if (videoState.active) {
            let currentSeek = videoState.timestamp;
            if (videoState.status === 'playing') {
                const timeDiff = (Date.now() - videoState.lastUpdate) / 1000;
                currentSeek += timeDiff;
            }
            socket.emit('video_launch', { ...videoState, timestamp: currentSeek });
        }
        
        socket.broadcast.emit('toast', { text: `${cleanName} entered the world` });
    });

    // --- TYPING INDICATOR ---
    socket.on('typing', (isTyping) => {
        const name = activeSockets[socket.id];
        if(name) socket.broadcast.emit('display_typing', { user: name, isTyping });
    });

    // --- PROFILE UPDATES ---
    socket.on('update_profile', (data) => {
        const name = activeSockets[socket.id];
        if (!name) return;
        
        const db = getDB();
        if (db.users[name]) {
            // Update fields safely (Bio, Location, Avatar)
            Object.assign(db.users[name], data);
            saveDB(db);
            // Confirm update to sender
            socket.emit('profile_updated', db.users[name]);
        }
    });

    // --- CHAT MESSAGING (Enhanced) ---
    socket.on('chat message', (data) => {
        try {
            const name = activeSockets[socket.id];
            if (!name) return;
            if (!data.content && data.type !== 'image') return; // Prevent empty msgs
            
            const db = getDB();
            const user = db.users[name];
            
            // Construct the ultimate message object
            const msg = {
                id: Date.now() + Math.random().toString(36).substr(2, 9),
                type: data.type || 'text', 
                content: data.content, 
                replyTo: data.replyTo || null, // Support for Replies
                user: user.name,
                avatar: user.avatar, 
                avatarColor: user.color,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false,
                reactions: {}
            };

            db.messages.push(msg);
            saveDB(db);
            io.emit('message_receive', msg);
        } catch (error) {
            console.error("Message Error:", error);
            socket.emit('toast', { text: "Error sending message. File might be too big." });
        }
    });

    // --- READ RECEIPTS ---
    socket.on('mark_read', (id) => {
        const db = getDB();
        const m = db.messages.find(x => x.id === id);
        if (m) { 
            m.read = true; 
            saveDB(db); 
        }
    });

    // --- REACTIONS ---
    socket.on('add_reaction', ({ id, emoji }) => {
        const db = getDB();
        const msg = db.messages.find(m => m.id === id);
        if(msg) {
            if(!msg.reactions) msg.reactions = {};
            if(!msg.reactions[emoji]) msg.reactions[emoji] = 0;
            msg.reactions[emoji]++;
            saveDB(db);
            io.emit('reaction_update', { id: msg.id, reactions: msg.reactions });
        }
    });

    // --- DELETE MESSAGE ---
    socket.on('delete_message', (id) => {
        const name = activeSockets[socket.id];
        const db = getDB();
        const msgIndex = db.messages.findIndex(m => m.id === id);
        
        // Security: Only allow deleting own messages
        if(msgIndex !== -1 && db.messages[msgIndex].user === name) {
            db.messages.splice(msgIndex, 1);
            saveDB(db);
            io.emit('message_removed', id);
        }
    });

    // --- VIDEO SYNC (Watch Party) ---
    socket.on('video_start', (data) => {
        videoState = {
            active: true, type: data.type, src: data.src,
            status: 'playing', timestamp: 0, lastUpdate: Date.now()
        };
        io.emit('video_launch', videoState);
        io.emit('toast', { text: 'Watch Party Started!' });
    });

    socket.on('video_sync', (data) => {
        // Sync state on server so new joiners get correct time
        videoState.status = (data.action === 'play') ? 'playing' : 'paused';
        videoState.timestamp = data.time;
        videoState.lastUpdate = Date.now();
        // Broadcast to others
        socket.broadcast.emit('video_update', data);
    });

    socket.on('video_close', () => {
        videoState.active = false;
        io.emit('video_terminate');
        io.emit('toast', { text: 'Watch Party Ended' });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        delete activeSockets[socket.id];
        io.emit('update_online_count', io.engine.clientsCount);
    });
});

// Run Server
server.listen(3000, '0.0.0.0', () => {
    console.log('✅ ProChat Ultimate Server Running on Port 3000');
});
