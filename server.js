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
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { v2: cloudinary } = require('cloudinary');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    maxHttpBufferSize: 1e8 // 100 MB buffer limit for media uploads
});

app.use(express.json({ limit: '2mb' }));

app.get('/health', (request, response) => response.json({ status: 'ok' }));

const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
let database;

async function getDatabase() {
    if (!mongoClient) throw new Error('MONGODB_URI is not configured');
    if (!database) {
        await mongoClient.connect();
        database = mongoClient.db(process.env.MONGODB_DB || 'npl-auction');
        await database.collection('rooms').createIndex({ tournamentId: 1 }, { unique: true });
        await database.collection('rooms').createIndex({ email: 1 });
    }
    return database;
}

function normalizeTournamentId(value) {
    return String(value || '').trim().toUpperCase();
}

function isValidTournamentId(value) {
    return /^[A-Z0-9_-]{3,32}$/.test(value);
}

function issueToken(room, role) {
    return jwt.sign({ roomId: room._id.toString(), tournamentId: room.tournamentId, role }, JWT_SECRET, { expiresIn: '12h' });
}

function authenticateRequest(request, response, next) {
    try {
        const header = request.headers.authorization || '';
        if (!header.startsWith('Bearer ')) throw new Error('Missing token');
        request.user = jwt.verify(header.slice(7), JWT_SECRET);
        next();
    } catch (error) {
        response.status(401).json({ error: 'Please sign in again.' });
    }
}

function sendServerError(response, error) {
    console.error(error.message);
    response.status(503).json({
        error: 'Database unavailable. Check the MongoDB URI, Atlas network access, and Render environment variables.'
    });
}

app.post('/api/auth/register', async (request, response) => {
    const { email, tournamentId, password, title } = request.body || {};
    const normalizedId = normalizeTournamentId(tournamentId);
    if (!/^\S+@\S+\.\S+$/.test(String(email || '').trim()) || !isValidTournamentId(normalizedId) || String(password || '').length < 6 || !String(title || '').trim()) {
        return response.status(400).json({ error: 'Enter a valid email, Tournament ID, password, and title.' });
    }

    try {
        const rooms = (await getDatabase()).collection('rooms');
        const room = {
            email: String(email).trim().toLowerCase(),
            tournamentId: normalizedId,
            passwordHash: await bcrypt.hash(password, 12),
            title: String(title).trim(),
            auctionState: createEmptyAuctionState(),
            createdAt: new Date()
        };
        const result = await rooms.insertOne(room);
        room._id = result.insertedId;
        response.status(201).json({ token: issueToken(room, 'admin'), tournamentId: room.tournamentId, title: room.title, role: 'admin' });
    } catch (error) {
        if (error.code === 11000) return response.status(409).json({ error: 'That Tournament ID is already in use.' });
        sendServerError(response, error);
    }
});

app.post('/api/auth/login/admin', async (request, response) => {
    const { email, tournamentId, password } = request.body || {};
    try {
        const room = await (await getDatabase()).collection('rooms').findOne({
            email: String(email || '').trim().toLowerCase(),
            tournamentId: normalizeTournamentId(tournamentId)
        });
        if (!room || !(await bcrypt.compare(String(password || ''), room.passwordHash))) {
            return response.status(401).json({ error: 'Invalid admin email, Tournament ID, or password.' });
        }
        response.json({ token: issueToken(room, 'admin'), tournamentId: room.tournamentId, title: room.title, role: 'admin' });
    } catch (error) {
        sendServerError(response, error);
    }
});

app.post('/api/auth/login/participant', async (request, response) => {
    try {
        const room = await (await getDatabase()).collection('rooms').findOne({ tournamentId: normalizeTournamentId(request.body && request.body.tournamentId) });
        if (!room) return response.status(404).json({ error: 'Tournament room not found.' });
        response.json({ token: issueToken(room, 'participant'), tournamentId: room.tournamentId, title: room.title, role: 'participant' });
    } catch (error) {
        sendServerError(response, error);
    }
});

app.get('/api/rooms/:tournamentId', async (request, response) => {
    try {
        const room = await (await getDatabase()).collection('rooms').findOne(
            { tournamentId: normalizeTournamentId(request.params.tournamentId) },
            { projection: { _id: 0, tournamentId: 1, title: 1 } }
        );
        if (!room) return response.status(404).json({ error: 'Tournament room not found.' });
        response.json(room);
    } catch (error) {
        sendServerError(response, error);
    }
});

// Serve static assets
app.use(express.static('public'));
app.get('/', (request, response) => response.sendFile(path.join(__dirname, 'public', 'Login.html')));
app.get('/Display.html', (request, response) => response.sendFile(path.join(__dirname, 'public', 'display.html')));

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

function getMediaMap() {
    return mediaMap;
}

function uploadMediaToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
        uploadStream.end(buffer);
    });
}

// ==================== IN-MEMORY AUCTION STATE ====================

const auctionStates = new Map();
let activeTournamentId = '';

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
let mediaMap = {};

function createEmptyAuctionState() {
    return {
        auctionTitle: '',
        auctionConfig: { baseTeamAmount: 1000, basePlayerPrice: 20, minPlayers: 9, maxPlayers: 15 },
        teamNames: [],
        playerList: [],
        teams: [],
        soldPlayers: [],
        soldNumbers: [],
        availableNumbers: [],
        skippedNumbers: [],
        currentNumber: null,
        mediaMap: {}
    };
}

async function loadAuctionState(tournamentId) {
    if (auctionStates.has(tournamentId)) return auctionStates.get(tournamentId);
    const room = await (await getDatabase()).collection('rooms').findOne({ tournamentId }, { projection: { title: 1, auctionState: 1 } });
    const saved = room && room.auctionState ? room.auctionState : createEmptyAuctionState();
    if (!saved.auctionTitle && room && room.title) saved.auctionTitle = room.title;
    saved.teams = Array.isArray(saved.teams) ? saved.teams : [];
    saved.soldPlayers = Array.isArray(saved.soldPlayers) ? saved.soldPlayers : [];
    saved.soldNumbers = Array.isArray(saved.soldNumbers) ? saved.soldNumbers : [];
    saved.availableNumbers = Array.isArray(saved.availableNumbers) ? saved.availableNumbers : [];
    saved.skippedNumbers = Array.isArray(saved.skippedNumbers) ? saved.skippedNumbers : [];
    saved.mediaMap = saved.mediaMap && typeof saved.mediaMap === 'object' ? saved.mediaMap : {};
    auctionStates.set(tournamentId, saved);
    return saved;
}

function activateAuctionState(tournamentId, state) {
    activeTournamentId = tournamentId;
    auctionTitle = state.auctionTitle;
    auctionConfig = state.auctionConfig;
    teamNames = state.teamNames;
    playerList = state.playerList;
    teams = state.teams;
    soldPlayers = new Set(state.soldPlayers);
    soldNumbers = new Set(state.soldNumbers);
    availableNumbers = state.availableNumbers;
    skippedNumbers = state.skippedNumbers;
    currentNumber = state.currentNumber;
    mediaMap = state.mediaMap;
}

async function persistActiveAuctionState() {
    const state = auctionStates.get(activeTournamentId);
    if (!state) return;
    state.auctionTitle = auctionTitle;
    state.auctionConfig = auctionConfig;
    state.teamNames = teamNames;
    state.playerList = playerList;
    state.teams = teams;
    state.soldPlayers = [...soldPlayers];
    state.soldNumbers = [...soldNumbers];
    state.availableNumbers = availableNumbers;
    state.skippedNumbers = skippedNumbers;
    state.currentNumber = currentNumber;
    state.mediaMap = mediaMap;
    await (await getDatabase()).collection('rooms').updateOne(
        { tournamentId: activeTournamentId },
        { $set: { auctionState: state, updatedAt: new Date() } }
    );
}

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
    io.to(`auction:${activeTournamentId}`).emit('number-update', {
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

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) return next(new Error('Authentication required'));
        socket.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        next(new Error('Invalid or expired session'));
    }
});

io.on('connection', async socket => {
    const tournamentId = socket.user.tournamentId;
    const socketRoom = `auction:${tournamentId}`;
    socket.join(socketRoom);
    activateAuctionState(tournamentId, await loadAuctionState(tournamentId));
    const useRoomState = () => activateAuctionState(tournamentId, auctionStates.get(tournamentId));
    const requireAdmin = () => {
        if (socket.user.role === 'admin') return true;
        socket.emit('message', { text: 'Admin access is required for this action.', type: 'error' });
        return false;
    };

    // Send initial configuration, state, and media map on connection
    socket.emit('config-update', { auctionTitle, auctionConfig, teamNames, playerList });
    socket.emit('update', { teams, soldPlayers: [...soldPlayers] });
    socket.emit('media-update', getMediaMap(tournamentId));
    socket.emit('number-update', {
        number: currentNumber,
        phase: availableNumbers.some(number => !soldNumbers.has(number)) ? 'main' : 'skipped'
    });

    // Event: Media upload batch handler
    socket.on('upload-media-batch', async files => {
        useRoomState();
        if (!requireAdmin()) return;
        if (!Array.isArray(files) || files.length === 0) return;

        if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            socket.emit('message', { text: 'Cloudinary is not configured on the server.', type: 'error' });
            return;
        }

        const results = await Promise.allSettled(files.map(async item => {
            if (!item || !item.filename || !item.buffer) throw new Error('Missing file data');

            const ext = path.extname(item.filename).toLowerCase();
            const basename = path.basename(item.filename, ext);
            if (!/^\d+$/.test(basename) || Number(basename) < 1) {
                throw new Error(`File name must contain only a positive number: ${item.filename}`);
            }

            const serial = Number(basename);
            const isVideo = ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);
            const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].includes(ext);
            if (!isVideo && !isImage) throw new Error(`Unsupported media type: ${item.filename}`);

            const result = await uploadMediaToCloudinary(Buffer.from(item.buffer), {
                public_id: `npl-auction/${tournamentId}/${serial}`,
                resource_type: 'auto',
                type: 'upload',
                overwrite: true,
                invalidate: true
            });

            return {
                serial,
                url: result.secure_url,
                type: isVideo ? 'video' : 'image',
                ext,
                filename: `${serial}${ext}`
            };
        }));

        let savedCount = 0;
        const errors = [];
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                mediaMap[result.value.serial] = result.value;
                savedCount++;
            } else {
                errors.push(result.reason.message);
            }
        });

        if (savedCount > 0) {
            await persistActiveAuctionState();
            io.to(socketRoom).emit('media-update', getMediaMap());
        }

        socket.emit('message', {
            text: `${savedCount} profile media file(s) uploaded to Cloudinary${errors.length ? `. ${errors.length} file(s) skipped.` : '.'}`,
            type: savedCount > 0 ? 'success' : 'error'
        });
    });

    // Event: Setup & Data Import submitted from Admin panel
    socket.on('setup-auction', data => {
        useRoomState();
        if (!requireAdmin()) return;
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

        io.to(socketRoom).emit('config-update', { auctionTitle, auctionConfig, teamNames, playerList });
        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.to(socketRoom).emit('media-update', getMediaMap());
        emitNumberUpdate();
        io.to(socketRoom).emit('message', {
            text: "⚙️ Auction setup updated and market reset!",
            type: "info"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('free-claim', data => {
        useRoomState();
        if (!requireAdmin()) return;
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

        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.to(socketRoom).emit('message', {
            text: `⚽ ${playerName} drafted for FREE by ${team.name}! 📝`,
            type: "success"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('bid', data => {
        useRoomState();
        if (!requireAdmin()) return;
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

        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.to(socketRoom).emit('message', {
            text: `⚽ ${playerName} signed by ${team.name} for ${bidAmount}! 📝`,
            type: "success"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('sell-player', data => {
        useRoomState();
        if (!requireAdmin()) return;
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

        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.to(socketRoom).emit('message', {
            text: `🔄 ${playerName} transferred from ${seller.name} to ${buyer.name} for ${price}! 📝`,
            type: "success"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('release-player', data => {
        useRoomState();
        if (!requireAdmin()) return;
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

        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        io.to(socketRoom).emit('message', {
            text: `🔓 ${playerName} released by ${owner.name}. Refund: ${originalCost} returned to budget.`,
            type: "info"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('roll-number', () => {
        useRoomState();
        if (!requireAdmin()) return;
        drawNextNumber();
        emitNumberUpdate();
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });

    socket.on('mark-unsold', () => {
        useRoomState();
        if (!requireAdmin()) return;
        if (currentNumber !== null) {
            completeNumber(currentNumber, true);
            persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
        }
    });

    socket.on('reset', () => {
        useRoomState();
        if (!requireAdmin()) return;
        resetAuctionState();
        io.to(socketRoom).emit('update', { teams, soldPlayers: [...soldPlayers] });
        emitNumberUpdate();
        io.to(socketRoom).emit('message', {
            text: "🔄 Auction has been reset to initial state.",
            type: "info"
        });
        persistActiveAuctionState().catch(error => console.error(`Auction state save failed: ${error.message}`));
    });
});

// ==================== START SERVER

getDatabase()
    .then(() => {
        server.listen(PORT, HOST, () => {
            const lanIp = getLocalNetworkIp();
            console.log(`NPL Auction Server running at http://localhost:${PORT}`);
            console.log(`Local Network: http://${lanIp}:${PORT}`);
            console.log(`Admin Panel: http://${lanIp}:${PORT}/TransferPanel.html`);
            console.log(`Live Display: http://${lanIp}:${PORT}/display.html`);
            console.log(`Player Profile: http://${lanIp}:${PORT}/playerProfileShowing.html`);
        });
    })
    .catch(error => {
        console.error(`MongoDB startup connection failed: ${error.message}`);
        process.exitCode = 1;
    });
