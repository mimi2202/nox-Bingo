import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ClientMessage } from './types';
import { createRoom, joinRoom, leaveRoom, startGame, drawBall, getPlayerRoom } from './RoomManager';
const PORT = parseInt(process.env.PORT || '3001');
const wss = new WebSocketServer({ port: PORT });
const connections = new Map<string, WebSocket>();
const playerNames = new Map<string, string>();
function send(ws: WebSocket, message: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
function broadcastToRoom(roomCode: string, message: object, excludePlayerId?: string) {
  connections.forEach((ws, playerId) => {
    const room = getPlayerRoom(playerId);
    if (room && room.code === roomCode && playerId !== excludePlayerId) {
      send(ws, message);
    }
  });
}
wss.on('connection', (ws: WebSocket) => {
  const playerId = uuidv4();
  connections.set(playerId, ws);
  console.log('Player connected: ' + playerId);
  ws.on('message', (data: Buffer) => {
    try {
      const message: ClientMessage = JSON.parse(data.toString());
      switch (message.type) {
        case 'create_room': {
          playerNames.set(playerId, message.playerName);
          const { room, messages } = createRoom(playerId, message.playerName);
          messages.forEach(msg => {
            if (msg.type === 'cards_dealt') {
              send(ws, msg);
            } else {
              // Send to creator
              send(ws, msg);
              // Broadcast to others in room
              broadcastToRoom(room.code, msg, playerId);
            }
          });
          console.log('Room created: ' + room.code + ' by ' + message.playerName);
          break;
        }
        case 'join_room': {
          playerNames.set(playerId, message.playerName);
          const { room, messages } = joinRoom(
            message.roomCode.toUpperCase(),
            playerId,
            message.playerName
          );
          if (room) {
            messages.forEach(msg => {
              if (msg.type === 'cards_dealt') {
                send(ws, msg);
              } else {
                // Send to everyone in room
                broadcastToRoom(room.code, msg);
                send(ws, msg);
              }
            });
            console.log(message.playerName + ' joined room ' + room.code);
          } else {
            messages.forEach(msg => send(ws, msg));
          }
          break;
        }
        case 'start_game': {
          const room = getPlayerRoom(playerId);
          if (!room) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          const { messages } = startGame(room.code, playerId);
          // Send cards privately to each player
          room.players.forEach((player, pid) => {
            const playerWs = connections.get(pid);
            if (playerWs) {
              send(playerWs, { type: 'cards_dealt', cards: player.cards });
            }
          });
          // Broadcast game start
          broadcastToRoom(room.code, { type: 'game_starting', countdown: 3 });
          // Start draw loop
          let drawInterval: NodeJS.Timeout;
          setTimeout(() => {
            drawInterval = setInterval(() => {
              const result = drawBall(room.code);
              if (!result.room) {
                clearInterval(drawInterval);
                return;
              }
              result.messages.forEach(msg => {
                broadcastToRoom(room.code, msg);
              });
              if (result.room.phase === 'finished') {
                clearInterval(drawInterval);
              }
            }, 3000);
          }, 3000);
          console.log('Game started in room ' + room.code);
          break;
        }
        case 'leave_room': {
          const { roomCode, messages } = leaveRoom(playerId);
          if (roomCode) {
            messages.forEach(msg => broadcastToRoom(roomCode, msg));
          }
          connections.delete(playerId);
          playerNames.delete(playerId);
          console.log('Player left: ' + playerId);
          break;
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
      send(ws, { type: 'error', message: 'Invalid message format' });
    }
  });
  ws.on('close', () => {
    const { roomCode, messages } = leaveRoom(playerId);
    if (roomCode) {
      messages.forEach(msg => broadcastToRoom(roomCode, msg));
    }
    connections.delete(playerId);
    playerNames.delete(playerId);
    console.log('Player disconnected: ' + playerId);
  });
});
console.log('NoxBingo server running on port ' + PORT);

