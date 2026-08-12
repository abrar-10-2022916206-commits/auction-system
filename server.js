const express = require('express');
const http = require('http');
const os = require('os');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

function getLocalNetworkIp() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const entry of interfaces[name] || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                return entry.address;
            }
        }
    }

    return 'localhost';
}

const BASE_TEAM_AMOUNT = 1000;
const BASE_PLAYER_PRICE = 20;
const MIN_PLAYERS = 9;
const MAX_PLAYERS = 15;

const TEAM_NAMES = [
            "Tiktok boyz",
            "Disco boys",
            "পারলে ঠেকাও",
            "শূণ্য রান এক্সপ্রেস",
            "আমরাই টপ আমরাই সব",
            "সাইক্লোন"
];

function createTeams() {
    return TEAM_NAMES.map(name => ({
        name,
        balance: BASE_TEAM_AMOUNT,
        players: []
    }));
}

let teams = createTeams();
let soldPlayers = new Set(); // track sold player names

io.on('connection', socket => {
    // Send full state on connect
    socket.emit('update', { teams, soldPlayers: [...soldPlayers] });

    socket.on('free-claim', data => {
    const teamIndex = parseInt(data.teamIndex);
    const playerName = data.player;

    if (isNaN(teamIndex) || teamIndex < 0 || teamIndex >= teams.length) {
        socket.emit('message', { text: "Invalid team selection.", type: "error" });
        return;
    }

    if (soldPlayers.has(playerName)) {
        socket.emit('message', { text: `${playerName} has already been acquired.`, type: "error" });
        return;
    }

    // Bypasses balance checks, squad maximum limits, and bank limits entirely
    const team = teams[teamIndex];
    team.players.push({ name: playerName, bid: 0 }); // Added with 0 cost
    soldPlayers.add(playerName);

    io.emit('update', { teams, soldPlayers: [...soldPlayers] });
    io.emit('message', {
        text: `⚽ ${playerName} drafted for FREE by ${team.name}! 📝`,
        type: "success"
    });
});
    // ---- BID ----
    socket.on('bid', data => {
        const teamIndex = parseInt(data.teamIndex);
        const bidAmount = parseInt(data.bid);
        const playerName = data.player;

        // Validation
        if (isNaN(teamIndex) || teamIndex < 0 || teamIndex >= teams.length) {
            socket.emit('message', { text: "Invalid team selection.", type: "error" });
            return;
        }

        if (isNaN(bidAmount) || bidAmount < BASE_PLAYER_PRICE) {
            socket.emit('message', {
                text: `Minimum bid is ${BASE_PLAYER_PRICE}. Please enter a valid amount.`,
                type: "error"
            });
            return;
        }

        if (!playerName || playerName.trim() === '') {
            socket.emit('message', { text: "Invalid player name.", type: "error" });
            return;
        }

        if (soldPlayers.has(playerName)) {
            socket.emit('message', {
                text: `${playerName} has already been sold.`,
                type: "error"
            });
            return;
        }

        const team = teams[teamIndex];

        if (team.players.length >= MAX_PLAYERS) {
            socket.emit('message', {
                text: `${team.name} has reached the maximum squad size (${MAX_PLAYERS}).`,
                type: "error"
            });
            return;
        }

        // Budget protection: reserve minimum funds for remaining required players
        const currentPlayers = team.players.length;
        const remainingRequired = Math.max(0, MIN_PLAYERS - (currentPlayers+1));
        const minimumKeep = remainingRequired * BASE_PLAYER_PRICE;
        const maxBid = team.balance - minimumKeep;

        if (bidAmount > maxBid) {
            socket.emit('message', {
                text: `${team.name} can bid at most ${maxBid} (must reserve funds for ${remainingRequired} more player${remainingRequired !== 1 ? 's' : ''}).`,
                type: "error"
            });
            return;
        }

        if (team.balance <= 0 || bidAmount > team.balance) {
            socket.emit('message', {
                text: `${team.name} has insufficient balance.`,
                type: "error"
            });
            return;
        }

        // Apply bid
        team.balance -= bidAmount;
        team.players.push({ name: playerName, bid: bidAmount });
        soldPlayers.add(playerName);

        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: `⚽ ${playerName} signed by ${team.name} for ${bidAmount}! 📝`,
            type: "success"
        });
    });
    

    socket.on('sell-player', data => {
        const playerName = data && data.player;
        const buyerIndex = parseInt(data && data.buyerIndex, 10);
        const price = parseInt(data && data.price, 10);

        if (!playerName || typeof playerName !== 'string' || isNaN(buyerIndex) || isNaN(price)) {
            socket.emit('message', {
                text: "Invalid sell request.",
                type: "error"
            });
            return;
        }

        if (price < BASE_PLAYER_PRICE) {
            socket.emit('message', {
                text: `Sell price must be at least ${BASE_PLAYER_PRICE}.`,
                type: "error"
            });
            return;
        }

        if (buyerIndex < 0 || buyerIndex >= teams.length) {
            socket.emit('message', {
                text: "Invalid buyer team.",
                type: "error"
            });
            return;
        }

        const sellerIndex = teams.findIndex(team => team.players.some(player => player.name === playerName));
        if (sellerIndex === -1) {
            socket.emit('message', {
                text: `${playerName} is not currently assigned to any team.`,
                type: "error"
            });
            return;
        }

        if (sellerIndex === buyerIndex) {
            socket.emit('message', {
                text: "Cannot sell to the same team.",
                type: "error"
            });
            return;
        }

        const seller = teams[sellerIndex];
        const buyer = teams[buyerIndex];
        const playerIndex = seller.players.findIndex(player => player.name === playerName);
        const player = seller.players[playerIndex];

        if (!player) {
            socket.emit('message', {
                text: `${playerName} could not be found on the selling team.`,
                type: "error"
            });
            return;
        }

        if (buyer.players.length >= MAX_PLAYERS) {
            socket.emit('message', {
                text: `${buyer.name} has reached the maximum squad size (${MAX_PLAYERS}).`,
                type: "error"
            });
            return;
        }

        const remainingRequired = Math.max(0, MIN_PLAYERS - (buyer.players.length + 1));
        const minimumKeep = remainingRequired * BASE_PLAYER_PRICE;
        const maxSpend = buyer.balance - minimumKeep;

        if (price > buyer.balance) {
            socket.emit('message', {
                text: `${buyer.name} has insufficient balance to pay ${price}.`,
                type: "error"
            });
            return;
        }

        if (price > maxSpend) {
            socket.emit('message', {
                text: `${buyer.name} can pay at most ${maxSpend} after reserving funds for required players.`,
                type: "error"
            });
            return;
        }

        seller.players.splice(playerIndex, 1);
        // Seller gets full selling price added to balance
        seller.balance += price;

        player.bid = price;
        buyer.balance -= price;
        buyer.players.push(player);
        soldPlayers.add(playerName);

        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: `🔄 ${playerName} transferred from ${seller.name} to ${buyer.name} for ${price}! 📝`,
            type: "success"
        });
    });

    // ---- RELEASE PLAYER (return to free market, refund original bid) ----
    socket.on('release-player', data => {
        const playerName = data && data.player;

        if (!playerName || typeof playerName !== 'string') {
            socket.emit('message', { text: "Invalid release request.", type: "error" });
            return;
        }

        const ownerIndex = teams.findIndex(team => team.players.some(p => p.name === playerName));
        if (ownerIndex === -1) {
            socket.emit('message', {
                text: `${playerName} is not currently assigned to any team.`,
                type: "error"
            });
            return;
        }

        const owner = teams[ownerIndex];
        const playerIndex = owner.players.findIndex(p => p.name === playerName);
        const player = owner.players[playerIndex];

        const originalCost = player.bid || 0;

        // Remove player from team and refund original bid
        owner.players.splice(playerIndex, 1);
        owner.balance += originalCost;

        // Make player available again
        soldPlayers.delete(playerName);

        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: `🔓 ${playerName} released by ${owner.name}. Refund: ${originalCost} returned to budget.`,
            type: "info"
        });
    });

    socket.on('roll-number', () => {
        io.emit('roll-number');
    });

    socket.on('mark-unsold', () => {
        io.emit('mark-unsold');
    });

    // ---- RESET ----
    socket.on('reset', () => {
        teams = createTeams();
        soldPlayers = new Set();
        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: "🔄 Auction has been reset to initial state.",
            type: "info"
        });
    });
});

server.listen(PORT, HOST, () => {
    const lanIp = getLocalNetworkIp();
    console.log(`🏆 NPL Auction Server running at http://localhost:${PORT}`);
    console.log(`   Local Network: http://${lanIp}:${PORT}`);
    console.log(`   Admin Panel : http://${lanIp}:${PORT}/admin.html`);
    console.log(`   Live Display: http://${lanIp}:${PORT}/display.html`);
});