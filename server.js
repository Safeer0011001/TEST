const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const os = require('os'); // Added for Server Stats

// --- SERVER CONFIG ---
// increased buffer to 100MB to support VIDEO files
const io = new Server(server, {
    maxHttpBufferSize: 1e8, 
    pingTimeout: 60000,
    cors: { origin: "*" }
});

const DB_FILE = path.join(__dirname, 'database.json');
const GOD_PASSWORD = "IAMNOOB";

// --- AUTO-MOD CONFIG ---
const BAD_WORDS = ["badword1", "badword2", "spam", "scam"]; // Add your list here
const REPLACEMENT = "****";

// --- DB & STATE ---
if (!fs.existsSync(DB_FILE)) {
    // Added 'ipBans' and 'pinned' to schema
    fs.writeFileSync(DB_FILE, JSON.stringify({ messages: [], users: {}, ipBans: [], pinned: null }, null, 2));
}

function getDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { messages: [], users: {}, ipBans: [], pinned: null }; } }
function saveDB(data) { try { if (data.messages.length > 150) data.messages = data.messages.slice(-150); fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {} }

// --- RUNTIME STATE ---
let videoState = { active: false, type: null, src: null };
let activeSockets = {}; // socket.id -> username
let socketLastMsg = {}; // Anti-Spam Timer
let floodCount = {}; // Anti-Flood Counter
let ghosts = new Set(); 
let mutedUsers = new Set();
let isChatFrozen = false;
let slowModeDelay = 0; // 0 = off, >0 = milliseconds delay required

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function updateCounts() {
    let count = io.engine.clientsCount;
    let visibleCount = Math.max(0, count - ghosts.size);
    io.emit('update_online_count', visibleCount);
}

// --- HELPER: FILTER TEXT ---
function cleanText(text) {
    if (!text || typeof text !== 'string') return text;
    let clean = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        clean = clean.replace(regex, REPLACEMENT);
    });
    return clean;
}

// --- HELPER: GET IP ---
function getIP(socket) {
    return socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
}

io.on('connection', (socket) => {
    const userIP = getIP(socket);
    const db = getDB();

    // 1. IP BAN CHECK
    if (db.ipBans && db.ipBans.includes(userIP)) {
        socket.emit('login_fail', "🚫 YOUR IP IS BANNED.");
        socket.disconnect(true);
        return;
    }

    // 2. JOIN EVENT
    socket.on('join', (username) => {
        let name = (username || "Anon").trim().substring(0, 20) || "Anon";
        
        // Check Username Ban
        if (db.bans && db.bans.includes(name)) {
            socket.emit('login_fail', "🚫 USERNAME BANNED.");
            socket.disconnect(true);
            return;
        }

        activeSockets[socket.id] = name;
        
        // Create User if new
        if (!db.users[name]) {
            db.users[name] = { name: name, avatar: null, color: '#6366F1', status: 'online', joinedAt: Date.now() };
            saveDB(db);
        } else {
            // Update status on rejoin
            db.users[name].status = 'online';
            saveDB(db);
        }

        // Send Initial Data
        socket.emit('login_success', db.users[name]);
        socket.emit('history', db.messages);
        
        // Send Pinned Message (Feature 11)
        if(db.pinned) socket.emit('sys_announce', db.pinned);
        
        // Check if video is currently playing for new joiner
        if(videoState.active) {
            socket.emit('video_launch', videoState);
        }

        updateCounts();
        socket.broadcast.emit('toast', { text: `${name} joined` });
        
        // Default Room
        socket.join('global');
    });

    // 3. GOD MODE / ADMIN ACTIONS
    socket.on('god_attempt', (pass) => {
        if (pass === GOD_PASSWORD) {
            socket.isAdmin = true;
            socket.emit('god_granted');
            // Send server stats on login
            const stats = {
                mem: (os.freemem() / 1024 / 1024).toFixed(2) + " MB Free",
                uptime: (os.uptime() / 60).toFixed(0) + " Mins",
                load: os.loadavg()[0].toFixed(2)
            };
            socket.emit('god_log', `SERVER STATS: RAM: ${stats.mem} | UP: ${stats.uptime}`);
        } else {
            socket.emit('god_denied');
        }
    });

    socket.on('get_active_users', () => { if(socket.isAdmin) socket.emit('update_user_list', Object.values(activeSockets)); });

    socket.on('god_action', ({ action, target }) => {
        if (!socket.isAdmin) return;
        const db = getDB();
        
        const findSock = (name) => {
            const id = Object.keys(activeSockets).find(k => activeSockets[k] === target);
            return id ? io.sockets.sockets.get(id) : null;
        };

        // --- NEW IP BAN LOGIC ---
        if (action === 'ban') {
            const s = findSock(target);
            const targetIP = s ? getIP(s) : null;
            
            // Ban Name
            if(!db.bans) db.bans = [];
            if(!db.bans.includes(target)) db.bans.push(target);
            
            // Ban IP
            if(targetIP) {
                if(!db.ipBans) db.ipBans = [];
                if(!db.ipBans.includes(targetIP)) db.ipBans.push(targetIP);
                io.emit('sys_alert', `🔨 ${target} (IP BANNED)`);
            } else {
                io.emit('sys_alert', `🔨 ${target} BANNED`);
            }
            
            saveDB(db);
            if(s) { s.emit('login_fail', "IP BANNED"); s.disconnect(true); }
        }

        if (action === 'kick') {
            const s = findSock(target);
            if(s) { s.disconnect(true); io.emit('toast', {text: `👢 ${target} Kicked`}); }
        }

        if (action === 'mute') { mutedUsers.add(target); socket.emit('god_log', `Muted ${target}`); }
        if (action === 'unmute') { mutedUsers.delete(target); socket.emit('god_log', `Unmuted ${target}`); }
        
        if (action === 'freeze') { isChatFrozen = true; io.emit('sys_alert', "❄️ CHAT FROZEN"); }
        if (action === 'thaw') { isChatFrozen = false; io.emit('toast', {text: "Chat Thawed"}); }
        if (action === 'nuke') { db.messages = []; saveDB(db); io.emit('sys_clear'); }
        
        // --- PERSISTENT ANNOUNCEMENT ---
        if (action === 'announce') { 
            db.pinned = target; 
            saveDB(db); 
            io.emit('sys_announce', target); 
        }
        if (action === 'clear_ann') { 
            db.pinned = null; 
            saveDB(db); 
            io.emit('sys_clear_ann'); 
        }

        // --- SLOW MODE ---
        if (action === 'slowmode') {
            // Target should be milliseconds (e.g., "1000" for 1 sec)
            slowModeDelay = parseInt(target) || 0;
            io.emit('sys_alert', slowModeDelay > 0 ? `🐢 SLOW MODE: ${slowModeDelay}ms` : "🐇 SLOW MODE OFF");
        }
        
        if (action === 'ghost') {
            if (ghosts.has(socket.id)) { ghosts.delete(socket.id); socket.emit('toast', {text: "👻 Ghost OFF"}); }
            else { ghosts.add(socket.id); socket.emit('toast', {text: "👻 Ghost ON"}); }
            updateCounts();
        }

        if (action === 'spy') {
            const s = findSock(target);
            if(s) socket.emit('spy_result', { user: target, ip: getIP(s), id: s.id });
        }
        
        if (action === 'chaos') io.emit('force_chaos');
    });

    // 4. CHAT MESSAGING
    socket.on('chat message', (data) => {
        const name = activeSockets[socket.id];
        if (!name) return;

        // A. Anti-Spam & Slow Mode Check
        const now = Date.now();
        const last = socketLastMsg[socket.id] || 0;
        
        // Check Slow Mode
        if (slowModeDelay > 0 && !socket.isAdmin) {
            if (now - last < slowModeDelay) {
                socket.emit('toast', {text: `🐢 Wait ${((slowModeDelay - (now-last))/1000).toFixed(1)}s`});
                return;
            }
        }
        
        // Check Flood (Rapid Fire)
        if (now - last < 200) {
            floodCount[socket.id] = (floodCount[socket.id] || 0) + 1;
            if (floodCount[socket.id] > 5) {
                mutedUsers.add(name);
                socket.emit('sys_alert', "🛑 MUTED FOR SPAMMING");
                return;
            }
        } else {
            floodCount[socket.id] = 0;
        }
        socketLastMsg[socket.id] = now;

        // B. Permissions Check
        if (mutedUsers.has(name) || (isChatFrozen && !socket.isAdmin)) return;

        // C. Clean Text
        if (data.type === 'text') {
            data.content = cleanText(data.content);
        }

        // D. Handle Video
        if (data.type === 'video') {
            if(!data.content || typeof data.content !== 'string') return;
        }

        // E. Private Message Handling
        if (data.type === 'text' && data.content.startsWith('/w')) {
            const parts = data.content.split(' ');
            const targetName = parts[1];
            const dmMsg = parts.slice(2).join(' ');
            
            const targetId = Object.keys(activeSockets).find(k => activeSockets[k] === targetName);
            if (targetId) {
                const payload = { 
                    id: Date.now(), type: 'text', content: dmMsg, 
                    user: name, isDM: true, time: new Date().toLocaleTimeString() 
                };
                io.to(targetId).emit('message_receive', payload);
                socket.emit('message_receive', payload);
            } else {
                socket.emit('toast', {text: "User not found"});
            }
            return;
        }

        // F. Save & Broadcast
        const db = getDB();
        const msg = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            type: data.type || 'text',
            content: data.content, 
            replyTo: data.replyTo || null,
            user: name,
            avatar: db.users[name]?.avatar, 
            avatarColor: db.users[name]?.color,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            read: false,
            ephemeral: data.ephemeral || false
        };

        if (!msg.ephemeral) {
            db.messages.push(msg);
            saveDB(db);
        }

        io.emit('message_receive', msg);

        if (msg.ephemeral) {
            setTimeout(() => {
                io.emit('message_removed', msg.id);
            }, 10000); 
        }
    });

    // 5. MESSAGE EDITING
    socket.on('edit_message', (d) => {
        const name = activeSockets[socket.id];
        const db = getDB();
        const msg = db.messages.find(m => m.id === d.id);
        
        if(msg && msg.user === name) {
            if(!msg.editHistory) msg.editHistory = [];
            msg.editHistory.push({ content: msg.content, time: Date.now() });
            
            msg.content = cleanText(d.content);
            msg.edited = true;
            saveDB(db);
            io.emit('message_edited', {id: d.id, content: msg.content});
        }
    });

    socket.on('delete_message', (id) => {
        const name = activeSockets[socket.id];
        const db = getDB();
        const msgIndex = db.messages.findIndex(m => m.id === id);
        
        if (msgIndex !== -1) {
            if (db.messages[msgIndex].user === name || socket.isAdmin) {
                db.messages.splice(msgIndex, 1);
                saveDB(db);
                io.emit('message_removed', id);
            }
        }
    });

    // 6. POLLS
    socket.on('create_poll', (q) => {
        const name = activeSockets[socket.id];
        const poll = {
            id: 'poll-' + Date.now(),
            type: 'poll',
            user: name,
            content: { 
                question: cleanText(q), 
                options: [{text:'Yes', votes:0}, {text:'No', votes:0}, {text:'Maybe', votes:0}],
                total: 0,
                id: 'poll-' + Date.now()
            },
            time: new Date().toLocaleTimeString()
        };
        const db = getDB();
        db.messages.push(poll);
        saveDB(db);
        io.emit('message_receive', poll);
    });

    socket.on('vote_poll', (d) => {
        const db = getDB();
        const msg = db.messages.find(m => m.id === d.id || (m.content && m.content.id === d.id));
        if(msg && msg.type === 'poll') {
            msg.content.options[d.opt].votes++;
            msg.content.total++;
            saveDB(db);
            io.emit('poll_update', msg.content);
        }
    });

    // 7. PROFILE & RICH PRESENCE
    socket.on('update_profile', (d) => {
        const n = activeSockets[socket.id];
        if(n) { 
            const db=getDB(); 
            if(d.bio) d.bio = cleanText(d.bio);
            Object.assign(db.users[n], d); 
            saveDB(db); 
        }
    });
    
    // --- ADDED: TYPING INDICATORS ---
    socket.on('typing', (user) => {
        // Broadcast to everyone EXCEPT the sender
        socket.broadcast.emit('display_typing', user);
    });
    
    socket.on('stop_typing', () => {
        socket.broadcast.emit('hide_typing');
    });
    
    // 8. WATCH PARTY (FIXED)
    socket.on('video_start', (d)=>{ 
        videoState = { active: true, ...d }; 
        io.emit('video_launch', videoState); 
    });
    
    // ** FIX: Renamed to match client & used broadcast to avoid loop **
    socket.on('video_sync', (d) => { 
        socket.broadcast.emit('video_sync_event', d); 
    }); 
    
    socket.on('video_close', () => { 
        videoState.active = false; 
        io.emit('video_terminate'); 
    });

    // 9. DISCONNECT
    socket.on('disconnect', () => {
        delete activeSockets[socket.id];
        if(ghosts.has(socket.id)) ghosts.delete(socket.id);
        updateCounts();
    });
});

server.listen(3000, '0.0.0.0', () => { console.log('✅ ProChat Server v18 Running'); });
