// netlify/functions/pokerGame.js
const { Server } = require('socket.io');
const { createServer } = require('http');

// Inicializar el servidor HTTP y Socket.IO
exports.handler = async function(event, context) {
  // Si no hay un servidor existente, crearlo
  if (!global.io) {
    const httpServer = createServer();
    global.io = new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    // Almacenamiento de juegos activos
    const games = {};
    
    // Conectar con Socket.IO
    global.io.on('connection', (socket) => {
      console.log('Cliente conectado:', socket.id);
      
      // Unirse como mesa
      socket.on('joinAsTable', ({ gameId, playerName }) => {
        // Crear juego si no existe
        if (!games[gameId]) {
          games[gameId] = createNewGame();
        }
        
        const game = games[gameId];
        game.tableSocketId = socket.id;
        
        // Unir al socket a la sala del juego
        socket.join(gameId);
        
        // Enviar estado inicial
        socket.emit('joined', { 
          playerId: 'table', 
          gameState: getFilteredGameState(game, 'table') 
        });
        
        console.log(`Mesa ${playerName} se unió al juego ${gameId}`);
      });
      
      // Unirse como jugador
      socket.on('joinAsPlayer', ({ gameId, playerName }) => {
        // Crear juego si no existe
        if (!games[gameId]) {
          games[gameId] = createNewGame();
        }
        
        const game = games[gameId];
        
        // Crear nuevo jugador
        const playerId = socket.id;
        const newPlayer = {
          id: playerId,
          name: playerName,
          socketId: socket.id,
          chips: 1000,
          bet: 0,
          folded: false,
          cards: []
        };
        
        // Añadir jugador al juego
        game.players.push(newPlayer);
        
        // Unir al socket a la sala del juego
        socket.join(gameId);
        
        // Enviar estado inicial
        socket.emit('joined', { 
          playerId, 
          gameState: getFilteredGameState(game, playerId) 
        });
        
        // Notificar a todos los jugadores
        global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
        
        console.log(`Jugador ${playerName} se unió al juego ${gameId}`);
        
        // Si hay suficientes jugadores, comenzar la ronda
        if (game.players.length >= 2 && !game.gameStarted) {
          startNewRound(gameId, game);
        }
      });
      
      // Acción del jugador
      socket.on('playerAction', ({ gameId, playerId, action, amount }) => {
        const game = games[gameId];
        if (!game) return;
        
        const playerIndex = game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;
        
        const player = game.players[playerIndex];
        
        // Procesar la acción del jugador
        switch (action) {
          case 'fold':
            player.folded = true;
            break;
            
          case 'check':
            // No hace nada, mantiene la apuesta actual
            break;
            
          case 'call':
            {
              const callAmount = game.currentBet - player.bet;
              player.chips -= callAmount;
              player.bet += callAmount;
              game.pot += callAmount;
            }
            break;
            
          case 'raise':
            {
              // Primero igualar la apuesta actual
              const callAmount = game.currentBet - player.bet;
              const raiseTotal = callAmount + amount;
              
              player.chips -= raiseTotal;
              player.bet += raiseTotal;
              game.pot += raiseTotal;
              game.currentBet = player.bet;
            }
            break;
        }
        
        // Actualizar el turno
        advanceTurn(game);
        
        // Comprobar si la ronda ha terminado
        if (isRoundOver(game)) {
          advanceGameState(gameId, game);
        } else {
          // Notificar a todos los jugadores
          global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
          
          // Notificar al jugador actual
          const currentPlayer = game.players[game.currentPlayerIndex];
          if (currentPlayer) {
            const options = calculateOptions(game, currentPlayer);
            global.io.to(currentPlayer.socketId).emit('playerTurn', { 
              playerId: currentPlayer.id, 
              options 
            });
          }
        }
      });
      
      // Iniciar nueva ronda
      socket.on('startNewRound', ({ gameId }) => {
        const game = games[gameId];
        if (!game) return;
        
        startNewRound(gameId, game);
      });
      
      // Desconexión
      socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
        
        // Eliminar jugador de cualquier juego
        for (const gameId in games) {
          const game = games[gameId];
          const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
          
          if (playerIndex !== -1) {
            // Eliminar jugador
            game.players.splice(playerIndex, 1);
            
            // Notificar a todos los jugadores
            global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
            
            console.log(`Jugador eliminado del juego ${gameId}`);
            
            // Si no quedan jugadores, eliminar el juego
            if (game.players.length === 0) {
              delete games[gameId];
              console.log(`Juego ${gameId} eliminado`);
            }
          }
          
          // Si la mesa se desconecta
          if (game.tableSocketId === socket.id) {
            game.tableSocketId = null;
          }
        }
      });
    });
    
    // Iniciar el servidor en un puerto aleatorio
    const PORT = 3000;
    httpServer.listen(PORT, () => {
      console.log(`Socket.IO server running at http://localhost:${PORT}`);
    });
  }
  
  // Respuesta para Netlify Functions
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Socket.IO server running" })
  };
};

// Funciones auxiliares
function createNewGame() {
  return {
    players: [],
    deck: createDeck(),
    communityCards: [],
    pot: 0,
    currentBet: 0,
    currentPlayerIndex: 0,
    dealerIndex: 0,
    smallBlind: 10,
    bigBlind: 20,
    gamePhase: 'waiting', // waiting, preflop, flop, turn, river, showdown
    tableSocketId: null,
    gameStarted: false
  };
}

function createDeck() {
  const suits = ['♥', '♦', '♣', '♠'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }
  
  return shuffleDeck(deck);
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  return shuffled;
}

function dealCards(game) {
  // Repartir 2 cartas a cada jugador
  for (const player of game.players) {
    player.cards = [game.deck.pop(), game.deck.pop()];
    player.folded = false;
    player.bet = 0;
  }
  
  // Resetear cartas comunitarias
  game.communityCards = [];
}

function startNewRound(gameId, game) {
  // Resetear el juego
  game.deck = createDeck();
  game.pot = 0;
  game.currentBet = 0;
  game.gamePhase = 'preflop';
  game.gameStarted = true;
  
  // Rotar el dealer
  game.dealerIndex = (game.dealerIndex + 1) % game.players.length;
  
  // Repartir cartas
  dealCards(game);
  
  // Configurar blinds
  const smallBlindIndex = (game.dealerIndex + 1) % game.players.length;
  const bigBlindIndex = (game.dealerIndex + 2) % game.players.length;
  
  // Small blind
  const smallBlindPlayer = game.players[smallBlindIndex];
  smallBlindPlayer.chips -= game.smallBlind;
  smallBlindPlayer.bet = game.smallBlind;
  game.pot += game.smallBlind;
  
  // Big blind
  const bigBlindPlayer = game.players[bigBlindIndex];
  bigBlindPlayer.chips -= game.bigBlind;
  bigBlindPlayer.bet = game.bigBlind;
  game.pot += game.bigBlind;
  
  // Configurar apuesta actual igual al big blind
  game.currentBet = game.bigBlind;
  
  // El primer jugador después del big blind comienza
  game.currentPlayerIndex = (bigBlindIndex + 1) % game.players.length;
  
  // Notificar a todos los jugadores
  global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
  
  // Notificar al jugador actual
  const currentPlayer = game.players[game.currentPlayerIndex];
  const options = calculateOptions(game, currentPlayer);
  global.io.to(currentPlayer.socketId).emit('playerTurn', { 
    playerId: currentPlayer.id, 
    options 
  });
}

function advanceTurn(game) {
  // Encontrar el siguiente jugador que no ha doblado
  let nextPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
  let loopCount = 0;
  
  while (loopCount < game.players.length) {
    if (!game.players[nextPlayerIndex].folded) {
      break;
    }
    nextPlayerIndex = (nextPlayerIndex + 1) % game.players.length;
    loopCount++;
  }
  
  game.currentPlayerIndex = nextPlayerIndex;
}

function isRoundOver(game) {
  // Si solo queda un jugador que no se ha doblado, la ronda termina
  const activePlayers = game.players.filter(p => !p.folded);
  if (activePlayers.length === 1) {
    return true;
  }
  
  // Comprobar si todos han igualado la apuesta
  const bets = new Set(game.players.filter(p => !p.folded).map(p => p.bet));
  return bets.size === 1;
}

function advanceGameState(gameId, game) {
  const activePlayers = game.players.filter(p => !p.folded);
  
  // Si solo queda un jugador, es el ganador
  if (activePlayers.length === 1) {
    const winner = activePlayers[0];
    winner.chips += game.pot;
    
    // Notificar el fin de la ronda
    global.io.to(gameId).emit('roundEnd', { 
      winner, 
      handDescription: 'Todos los demás jugadores se han doblado' 
    });
    
    // Actualizar el estado del juego
    global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
    return;
  }
  
  // Pasar a la siguiente fase
  switch (game.gamePhase) {
    case 'preflop':
      game.gamePhase = 'flop';
      // Repartir 3 cartas para el flop
      game.communityCards.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
      break;
      
    case 'flop':
      game.gamePhase = 'turn';
      // Repartir 1 carta para el turn
      game.communityCards.push(game.deck.pop());
      break;
      
    case 'turn':
      game.gamePhase = 'river';
      // Repartir 1 carta para el river
      game.communityCards.push(game.deck.pop());
      break;
      
    case 'river':
      // Mostrar cartas y determinar ganador
      game.gamePhase = 'showdown';
      determineWinner(gameId, game);
      return;
  }
  
  // Resetear apuestas para la nueva fase
  for (const player of game.players) {
    player.bet = 0;
  }
  game.currentBet = 0;
  
  // El primer jugador después del dealer comienza
  game.currentPlayerIndex = (game.dealerIndex + 1) % game.players.length;
  
  // Notificar a todos los jugadores
  global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
  
  // Notificar al jugador actual
  const currentPlayer = game.players[game.currentPlayerIndex];
  if (!currentPlayer.folded) {
    const options = calculateOptions(game, currentPlayer);
    global.io.to(currentPlayer.socketId).emit('playerTurn', { 
      playerId: currentPlayer.id, 
      options 
    });
  } else {
    advanceTurn(game);
    
    const nextPlayer = game.players[game.currentPlayerIndex];
    const options = calculateOptions(game, nextPlayer);
    global.io.to(nextPlayer.socketId).emit('playerTurn', { 
      playerId: nextPlayer.id, 
      options 
    });
  }
}

function determineWinner(gameId, game) {
  const activePlayers = game.players.filter(p => !p.folded);
  
  // Simplificación: elegir un ganador aleatorio
  // En un juego real, evaluaríamos las manos de cada jugador
  const winnerIndex = Math.floor(Math.random() * activePlayers.length);
  const winner = activePlayers[winnerIndex];
  
  // Determinar qué mano tiene (simplificado)
  const handRanks = [
    'Carta Alta', 'Par', 'Doble Par', 'Trío', 
    'Escalera', 'Color', 'Full House', 'Póker', 
    'Escalera de Color', 'Escalera Real'
  ];
  const handRank = Math.floor(Math.random() * handRanks.length);
  const handDescription = handRanks[handRank];
  
  // Dar el bote al ganador
  winner.chips += game.pot;
  
  // Notificar el fin de ronda
  global.io.to(gameId).emit('roundEnd', { winner, handDescription });
  
  // Actualizar el estado del juego
  global.io.to(gameId).emit('gameState', getFilteredGameState(game, 'all'));
}

function calculateOptions(game, player) {
  return {
    canFold: true,
    canCheck: game.currentBet <= player.bet,
    canCall: game.currentBet > player.bet,
    canRaise: player.chips > game.currentBet - player.bet
  };
}

function getFilteredGameState(game, viewerId) {
  // Copia del estado del juego
  const state = {
    players: [],
    communityCards: game.communityCards,
    pot: game.pot,
    currentBet: game.currentBet,
    currentTurn: game.players[game.currentPlayerIndex]?.id,
    gamePhase: game.gamePhase
  };
  
  // Filtrar la información de los jugadores
  for (const player of game.players) {
    const playerInfo = {
      id: player.id,
      name: player.name,
      chips: player.chips,
      bet: player.bet,
      folded: player.folded
    };
    
    // Si es el propio jugador o la mesa, mostrar las cartas
    if (viewerId === player.id || viewerId === 'table') {
      playerInfo.cards = player.cards;
    } else {
      playerInfo.cards = [];
    }
    
    state.players.push(playerInfo);
  }
  
  return state;
}