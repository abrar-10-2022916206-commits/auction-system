/**
 * NPL Auction Server — Real-time Transfer Market Engine
 * Handles socket communication, auction configuration, player biddings,
 * transfers, free claims, squad validations, random number drawings,
 * and profile media uploads (images/videos by serial number).
 */

const express = require('express');
const http = require('http');
const os = require('os');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    maxHttpBufferSize: 1e8 // 100 MB buffer limit for media uploads
});

// Serve static assets
app.use(express.static('public'));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

/**
 * Utility to retrieve local IPv4 address for local network access
 */
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

// ==================== MEDIA MANAGEMENT ====================

/**
 * Scans public/uploads for media files mapped by serial number (e.g., 1.png, 2.mp4)
 */
function getMediaMap() {
    const mediaMap = {};
    if (!fs.existsSync(uploadsDir)) return mediaMap;

    try {
        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            if (file.startsWith('.')) return;
            const ext = path.extname(file).toLowerCase();
            const basename = path.basename(file, ext);
            const serial = parseInt(basename, 10);
            if (!isNaN(serial) && serial > 0) {
                const isVideo = ['.mp4', '.webm'].includes(ext);
                const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
                if (isVideo || isImage) {
                    mediaMap[serial] = {
                        url: `/uploads/${file}`,
                        type: isVideo ? 'video' : 'image',
                        ext: ext,
                        filename: file
                    };
                }
            }
        });
    } catch (e) {
        console.error("Error reading uploads directory:", e);
    }
    return mediaMap;
}

// ==================== IN-MEMORY AUCTION STATE ====================

let auctionTitle = "";
let auctionConfig = {
    baseTeamAmount: 1000,
    basePlayerPrice: 20,
    minPlayers: 9,
    maxPlayers: 15
};

let teamNames = [];
let playerList = [];

function createTeams() {
    return teamNames.map(name => ({
        name,
        balance: auctionConfig.baseTeamAmount,
        players: []
    }));
}

let teams = createTeams();
let soldPlayers = new Set();
let soldNumbers = new Set();
let availableNumbers = [];
let skippedNumbers = [];
let currentNumber = null;

// ==================== RANDOM NUMBER DRAWING HELPERS ====================

function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function removeNumber(numbers, number) {
    const index = numbers.indexOf(number);
    if (index !== -1) numbers.splice(index, 1);
}

function drawNextNumber() {
    const candidates = availableNumbers.filter(number => !soldNumbers.has(number));
    if (candidates.length > 0) {
        currentNumber = randomItem(candidates);
        removeNumber(availableNumbers, currentNumber);
    } else {
        const unsoldSkipped = skippedNumbers.filter(number => !soldNumbers.has(number));
        currentNumber = unsoldSkipped.length > 0 ? randomItem(unsoldSkipped) : null;
    }
}

function emitNumberUpdate() {
    io.emit('number-update', {
        number: currentNumber,
        phase: availableNumbers.some(number => !soldNumbers.has(number)) ? 'main' : 'skipped'
    });
}

function completeNumber(number, isSkipped = false) {
    const total = playerList.length;
    if (!Number.isInteger(number) || number < 1 || number > total) return;

    removeNumber(availableNumbers, number);
    removeNumber(skippedNumbers, number);
    if (isSkipped) skippedNumbers.push(number);
    else soldNumbers.add(number);

    if (currentNumber !== null && currentNumber !== number && !soldNumbers.has(currentNumber) && !skippedNumbers.includes(currentNumber)) {
        availableNumbers.push(currentNumber);
    }

    drawNextNumber();
    emitNumberUpdate();
}

function resetNumberState() {
    soldNumbers = new Set();
    availableNumbers = Array.from({ length: playerList.length }, (_, index) => index + 1);
    skippedNumbers = [];
    currentNumber = null;
    if (playerList.length > 0) {
        drawNextNumber();
    }
}

function resetAuctionState() {
    teams = createTeams();
    soldPlayers = new Set();
    resetNumberState();
}

resetNumberState();

// ==================== SOCKET REAL-TIME EVENTS ====================

io.on('connection', socket => {
    // Send initial configuration, state, and media map on connection
    socket.emit('config-update', { auctionTitle, auctionConfig, teamNames, playerList });
    socket.emit('update', { teams, soldPlayers: [...soldPlayers] });
    socket.emit('media-update', getMediaMap());
    socket.emit('number-update', {
        number: currentNumber,
        phase: availableNumbers.some(number => !soldNumbers.has(number)) ? 'main' : 'skipped'
    });

    // Event: Media upload batch handler
    socket.on('upload-media-batch', files => {
        if (Array.isArray(files) && files.length > 0) {
            let savedCount = 0;
            files.forEach(item => {
                if (item && item.filename && item.buffer) {
                    const ext = path.extname(item.filename).toLowerCase();
                    const basename = path.basename(item.filename, ext);
                    const serial = parseInt(basename, 10);
                    if (!isNaN(serial) && serial > 0) {
                        const isVideo = ['.mp4', '.webm'].includes(ext);
                        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
                        if (isVideo || isImage) {
                            const destPath = path.join(uploadsDir, `${serial}${ext}`);
                            fs.writeFileSync(destPath, Buffer.from(item.buffer));
                            savedCount++;
                        }
                    }
                }
            });
            const updatedMap = getMediaMap();
            io.emit('media-update', updatedMap);
            socket.emit('message', {
                text: `📸 Successfully uploaded ${savedCount} profile media file(s)!`,
                type: 'success'
            });
        }
    });

    // Event: Setup & Data Import submitted from Admin panel
    socket.on('setup-auction', data => {
        if (typeof data.title === 'string') {
            auctionTitle = data.title.trim();
        }

        if (data.config && typeof data.config === 'object') {
            const { baseTeamAmount, basePlayerPrice, minPlayers, maxPlayers } = data.config;
            if (Number(baseTeamAmount) > 0) auctionConfig.baseTeamAmount = Number(baseTeamAmount);
            if (Number(basePlayerPrice) > 0) auctionConfig.basePlayerPrice = Number(basePlayerPrice);
            if (Number(minPlayers) > 0) auctionConfig.minPlayers = Number(minPlayers);
            if (Number(maxPlayers) > 0) auctionConfig.maxPlayers = Number(maxPlayers);
        }

        if (Array.isArray(data.teamNames)) {
            teamNames = data.teamNames.map(t => String(t).trim()).filter(Boolean);
        }

        if (Array.isArray(data.playerList)) {
            playerList = data.playerList.map(p => String(p).trim()).filter(Boolean);
        }

        resetAuctionState();

        io.emit('config-update', { auctionTitle, auctionConfig, teamNames, playerList });
        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('media-update', getMediaMap());
        emitNumberUpdate();
        io.emit('message', {
            text: "⚙️ Auction setup updated and market reset!",
            type: "info"
        });
    });

    socket.on('free-claim', data => {
        const teamIndex = parseInt(data.teamIndex);
        const playerName = data.player;
        const playerSerial = parseInt(data.serial, 10);

        if (isNaN(teamIndex) || teamIndex < 0 || teamIndex >= teams.length) {
            socket.emit('message', { text: "Invalid team selection.", type: "error" });
            return;
        }

        if (soldPlayers.has(playerName)) {
            socket.emit('message', { text: `${playerName} has already been acquired.`, type: "error" });
            return;
        }

        const team = teams[teamIndex];
        team.players.push({ name: playerName, bid: 0 });
        soldPlayers.add(playerName);
        completeNumber(playerSerial);

        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: `⚽ ${playerName} drafted for FREE by ${team.name}! 📝`,
            type: "success"
        });
    });

    socket.on('bid', data => {
        const teamIndex = parseInt(data.teamIndex);
        const bidAmount = parseInt(data.bid);
        const playerName = data.player;
        const playerNumber = parseInt(data.serial, 10);

        if (isNaN(teamIndex) || teamIndex < 0 || teamIndex >= teams.length) {
            socket.emit('message', { text: "Invalid team selection.", type: "error" });
            return;
        }

        if (isNaN(bidAmount) || bidAmount < auctionConfig.basePlayerPrice) {
            socket.emit('message', {
                text: `Minimum bid is ${auctionConfig.basePlayerPrice}. Please enter a valid amount.`,
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

        if (team.players.length >= auctionConfig.maxPlayers) {
            socket.emit('message', {
                text: `${team.name} has reached the maximum squad size (${auctionConfig.maxPlayers}).`,
                type: "error"
            });
            return;
        }

        const currentPlayers = team.players.length;
        const remainingRequired = Math.max(0, auctionConfig.minPlayers - (currentPlayers + 1));
        const minimumKeep = remainingRequired * auctionConfig.basePlayerPrice;
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

        team.balance -= bidAmount;
        team.players.push({ name: playerName, bid: bidAmount });
        soldPlayers.add(playerName);
        completeNumber(playerNumber);

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

        if (price < auctionConfig.basePlayerPrice) {
            socket.emit('message', {
                text: `Sell price must be at least ${auctionConfig.basePlayerPrice}.`,
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

        if (buyer.players.length >= auctionConfig.maxPlayers) {
            socket.emit('message', {
                text: `${buyer.name} has reached the maximum squad size (${auctionConfig.maxPlayers}).`,
                type: "error"
            });
            return;
        }

        const remainingRequired = Math.max(0, auctionConfig.minPlayers - (buyer.players.length + 1));
        const minimumKeep = remainingRequired * auctionConfig.basePlayerPrice;
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

    socket.on('release-player', data => {
        const playerName = data && data.player;
        const playerSerial = data && data.serial;

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

        owner.players.splice(playerIndex, 1);
        owner.balance += originalCost;

        soldPlayers.delete(playerName);
        soldNumbers.delete(playerSerial);
        if (Number.isInteger(playerSerial) && playerSerial >= 1 && playerSerial <= playerList.length && playerSerial !== currentNumber && !availableNumbers.includes(playerSerial)) {
            removeNumber(skippedNumbers, playerSerial);
            availableNumbers.push(playerSerial);
        }

        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.emit('message', {
            text: `🔓 ${playerName} released by ${owner.name}. Refund: ${originalCost} returned to budget.`,
            type: "info"
        });
    });

    socket.on('roll-number', () => {
        drawNextNumber();
        emitNumberUpdate();
    });

    socket.on('mark-unsold', () => {
        if (currentNumber !== null) completeNumber(currentNumber, true);
    });

    socket.on('reset', () => {
        resetAuctionState();
        io.emit('update', { teams, soldPlayers: [...soldPlayers] });
        emitNumberUpdate();
        io.emit('message', {
            text: "🔄 Auction has been reset to initial state.",
            type: "info"
        });
    });
});

// ==================== START SERVER

server.listen(PORT, HOST, () => {
    const lanIp = getLocalNetworkIp();
    console.log(`🏆 NPL Auction Server running at http://localhost:${PORT}`);
    console.log(`   Local Network: http://${lanIp}:${PORT}`);
    console.log(`   Admin Panel   : http://${lanIp}:${PORT}/admin.html`);
    console.log(`   Live Display  : http://${lanIp}:${PORT}/display.html`);
    console.log(`   Player Profile: http://${lanIp}:${PORT}/playerProfileShowing.html`);
});
