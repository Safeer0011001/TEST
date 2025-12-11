const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const sanitizeHtml = require('sanitize-html'); // Security feature

const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Store connected users: { socketId: "Username" }
let users = {};

io.on('connection', (socket) => {
  
  // 1. Handle User Joining
  socket.on('join', (username) => {
    // Sanitize username to prevent injection
    const cleanName = sanitizeHtml(username, { allowedTags: [] }) || "Anonymous";
    users[socket.id] = cleanName;
    
    // Tell everyone else this user joined
    socket.broadcast.emit('system_message', `${cleanName} has joined the chat`);
    console.log(`${cleanName} connected`);
  });

  // 2. Handle Chat Messages
  socket.on('chat message', (msg) => {
    const user = users[socket.id];
    if (user && msg.trim().length > 0) {
      // Create a message object with time and sender
      const messageData = {
        text: sanitizeHtml(msg, { allowedTags: [] }),
        user: user,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        id: socket.id // Used to identify 'me' vs 'others' on frontend
      };
      io.emit('chat message', messageData);
    }
  });

  // 3. Handle Typing Indicator
  socket.on('typing', () => {
    const user = users[socket.id];
    if (user) {
      socket.broadcast.emit('user_typing', user);
    }
  });

  // 4. Handle Disconnect
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      socket.broadcast.emit('system_message', `${user} has left the chat`);
      delete users[socket.id];
    }
  });
});

// Listen on all network interfaces
server.listen(3000, '0.0.0.0', () => {
  console.log('🚀 Premium Server running on port 3000');
});
