import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ClientMessage } from './types';
import { createRoom, joinRoom, leaveRoom, startGame, drawBall, getPlayerRoom, setWallet, markEntryFeePaid, removePlayer, roomEvents, getPayoutAmount, CARD_BUNDLES } from './RoomManager';
import { TREASURY_PUBLIC_KEY, payWinner, verifyEntryFeePayment } from './solana';

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

// Fires after a 'bingo' message. Runs async so it never blocks the
// draw loop; broadcasts the payout result once it settles.
async function handleWinnerPayout(roomCode: string, winnerId: string) {
  const room = getPlayerRoom(winnerId);
  const currentRoom = room && room.code === roomCode ? room : undefined;
  if (!currentRoom) return;

  const winner = currentRoom.players.get(winnerId);
  if (!winner?.walletAddress) {
    broadcastToRoom(roomCode, {
      type: 'payout_error',
      message: 'Winner has no connected wallet — payout could not be sent.',
    });
    return;
  }

  const totalPrize = getPayoutAmount(currentRoom);
  try {
    const txSignature = await payWinner(winner.walletAddress, totalPrize);
    broadcastToRoom(roomCode, { type: 'payout_sent', winnerId, txSignature, amount: totalPrize });
  } catch (err) {
    console.error('payWinner failed:', err);
    broadcastToRoom(roomCode, {
      type: 'payout_error',
      message: 'Payout failed. Support may need to send the prize manually.',
    });
  }
}

// Auto-removal from the wallet-connect timeout fires on its own timer,
// not as a direct response to a client message, so it comes through
// as an event instead of an inline return value.
roomEvents.on('player_removed', ({ roomCode, playerId, messages, reason }) => {
  messages.forEach((msg: object) => broadcastToRoom(roomCode, msg));
  const ws = connections.get(playerId);
  if (ws) {
    send(ws, { type: 'removed_from_room', reason });
    ws.close();
  }
  connections.delete(playerId);
  playerNames.delete(playerId);
  console.log('Player ' + playerId + ' auto-removed from ' + roomCode + ' (' + reason + ')');
});

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
          const { room, messages } = createRoom(
            playerId,
            message.playerName,
            message.walletAddress || null,
            message.maxPlayers
          );
          messages.forEach(msg => {
            if (msg.type === 'cards_dealt') {
              send(ws, msg);
            } else {
              send(ws, msg);
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
            message.playerName,
            message.walletAddress || null
          );
          if (room) {
            messages.forEach(msg => {
              if (msg.type === 'cards_dealt') {
                send(ws, msg);
              } else {
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
        case 'set_wallet': {
          const { room, messages } = setWallet(playerId, message.walletAddress);
          if (room) {
            messages.forEach(msg => broadcastToRoom(room.code, msg));
          }
          break;
        }
        case 'submit_entry_fee': {
          const room = getPlayerRoom(playerId);
          if (!room) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          const player = room.players.get(playerId);
          if (!player?.walletAddress) {
            send(ws, { type: 'entry_fee_rejected', message: 'Connect a wallet before paying the entry fee' });
            return;
          }
          const bundle = CARD_BUNDLES.find(b => b.id === message.bundleId);
          if (!bundle) {
            send(ws, { type: 'entry_fee_rejected', message: 'Unknown bundle selected.' });
            return;
          }
          verifyEntryFeePayment(message.txSignature, player.walletAddress, bundle.priceOren)
            .then(result => {
              if (!result.ok) {
                send(ws, { type: 'entry_fee_rejected', message: result.reason || 'Could not verify that payment on-chain.' });
                return;
              }
              const { room: updatedRoom, messages } = markEntryFeePaid(playerId, bundle.id);
              if (updatedRoom) {
                messages.forEach(msg => broadcastToRoom(updatedRoom.code, msg));
              }
            })
            .catch(err => {
              console.error('verifyEntryFeePayment failed:', err);
              send(ws, { type: 'entry_fee_rejected', message: 'Could not verify payment right now — try again in a moment.' });
            });
          break;
        }
        case 'remove_player': {
          const { roomCode, messages } = removePlayer(playerId, message.playerId);
          if (roomCode) {
            messages.forEach(msg => broadcastToRoom(roomCode, msg));
            const targetWs = connections.get(message.playerId);
            if (targetWs) {
              send(targetWs, { type: 'removed_from_room', reason: 'host_removed' });
              targetWs.close();
            }
            connections.delete(message.playerId);
            playerNames.delete(message.playerId);
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
          const { room: startedRoom, messages } = startGame(room.code, playerId);
          if (!startedRoom) {
            messages.forEach(msg => send(ws, msg));
            return;
          }
          startedRoom.players.forEach((player, pid) => {
            const playerWs = connections.get(pid);
            if (playerWs) {
              send(playerWs, { type: 'cards_dealt', cards: player.cards });
            }
          });
          broadcastToRoom(startedRoom.code, { type: 'game_starting', countdown: 3 });
          let drawInterval: NodeJS.Timeout;
          setTimeout(() => {
            drawInterval = setInterval(() => {
              const result = drawBall(startedRoom.code);
              if (!result.room) {
                clearInterval(drawInterval);
                return;
              }
              result.messages.forEach(msg => {
                broadcastToRoom(startedRoom.code, msg);
                if (msg.type === 'bingo') {
                  handleWinnerPayout(startedRoom.code, msg.winnerId);
                }
              });
              if (result.room.phase === 'finished') {
                clearInterval(drawInterval);
              }
            }, 3000);
          }, 3000);
          console.log('Game started in room ' + startedRoom.code);
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
console.log('Treasury pubkey: ' + TREASURY_PUBLIC_KEY);