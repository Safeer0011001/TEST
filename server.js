const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const io = new Server(server, {
    maxHttpBufferSize: 5e7, // 50MB
    cors: { origin: "*" }
});

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE INIT ---
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ messages: [], users: {} }, null, 2));
}

function getDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return { messages: [], users: {} }; }
}

function saveDB(data) {
    if (data.messages.length > 100) data.messages.shift();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- VIDEO STATE ---
let videoState = {
    active: false,
    type: null, // 'youtube' or 'direct'
    src: null,
    status: 'paused', // 'playing' or 'paused'
    timestamp: 0,
    lastUpdate: Date.now()
};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let activeSockets = {};

io.on('connection', (socket) => {
    
    // 1. JOIN
    socket.on('join', (username) => {
        const db = getDB();
        const cleanName = username.trim() || "Anon";
        activeSockets[socket.id] = cleanName;

        if (!db.users[cleanName]) {
            db.users[cleanName] = {
                name: cleanName,
                avatar: null,
                color: '#6366F1',
                bio: "Using ProChat",
                location: "Unknown",
                gender: "Not Specified"
            };
            saveDB(db);
        }

        socket.emit('login_success', db.users[cleanName]);
        socket.emit('history', db.messages);

        // SYNC NEW USER TO CURRENT VIDEO
        if (videoState.active) {
            let currentSeek = videoState.timestamp;
            // If playing, calculate time passed since last update
            if (videoState.status === 'playing') {
                const timeDiff = (Date.now() - videoState.lastUpdate) / 1000;
                currentSeek += timeDiff;
            }
            
            socket.emit('video_launch', { 
                ...videoState, 
                timestamp: currentSeek 
            });
        }

        socket.broadcast.emit('toast', { type: 'info', text: `${cleanName} joined` });
    });

    // 2. PROFILE & CHAT (Standard)
    socket.on('update_profile', (data) => {
        const name = activeSockets[socket.id];
        if (!name) return;
        const db = getDB();
        if (db.users[name]) {
            Object.assign(db.users[name], data);
            saveDB(db);
            socket.emit('profile_updated', db.users[name]);
        }
    });

    socket.on('get_user_info', (target) => {
        const db = getDB();
        if (db.users[target]) socket.emit('show_user_popup', db.users[target]);
    });

    socket.on('chat message', (data) => {
        const name = activeSockets[socket.id];
        if (!name) return;
        const db = getDB();
        const user = db.users[name];
        const msg = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            type: data.type, content: data.content, user: user.name,
            avatar: user.avatar, avatarColor: user.color,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            read: false
        };
        db.messages.push(msg);
        saveDB(db);
        io.emit('message_receive', msg);
    });

    socket.on('mark_read', (id) => {
        const db = getDB();
        const m = db.messages.find(x => x.id === id);
        if (m) { m.read = true; saveDB(db); io.emit('message_updated_read', id); }
    });

    // 3. WATCH PARTY ENGINE (PRECISE SYNC)
    socket.on('video_start', (data) => {
        videoState = {
            active: true,
            type: data.type,
            src: data.src,
            status: 'playing',
            timestamp: 0,
            lastUpdate: Date.now()
        };
        io.emit('video_launch', videoState);
        io.emit('toast', { type: 'success', text: 'Watch Party Started!' });
    });

    socket.on('video_sync', (data) => {
        // data = { action: 'play'|'pause'|'seek', time: number }
        
        // Update Server State
        videoState.status = (data.action === 'play') ? 'playing' : 'paused';
        videoState.timestamp = data.time;
        videoState.lastUpdate = Date.now();

        // Broadcast to EVERYONE (including sender, to ensure precision, 
        // but sender will ignore due to local ID check if we implemented it, 
        // for now broadcasting to others is smoother)
        socket.broadcast.emit('video_update', data);
    });

    socket.on('video_close', () => {
        videoState.active = false;
        videoState.status = 'paused';
        io.emit('video_terminate');
        io.emit('toast', { type: 'info', text: 'Watch Party Ended' });
    });

    socket.on('disconnect', () => delete activeSockets[socket.id]);
});

server.listen(3000, '0.0.0.0', () => {
    console.log('✅ Sync Server running on 3000');
});
