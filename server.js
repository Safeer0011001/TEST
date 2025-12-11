const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// 1. Serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 2. Handle Chat Connections
io.on('connection', (socket) => {
  console.log('A user connected');

  // When the server receives a message from a client
  socket.on('chat message', (msg) => {
    // Send that message to EVERYONE connected
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// 3. Listen on Port 3000 (0.0.0.0 allows access from other devices)
server.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
});