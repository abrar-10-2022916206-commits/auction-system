// test-fill.js — Auto-fills ~40 bids to test the NPL Auction system
// Run with: node test-fill.js

const { io } = require('socket.io-client');

const socket = io('http://localhost:3000');

// Players from admin.html (first 40)
const players = [
    "Ashik Miah_10", 
            "Md. Meharub Hossain_12", 
            "Md. Ripon Hossen_NE-11", 
            "Sudipto Mondal Mahin_12", 
            "Dyhan Alam_NE12", 
            "Fahim Shahriar_11", 
            "Sifatuzzaman Sium_NE-12", 
            "Md Ashab Al Hasib Kabyo_12", 
            "MD Ilia's mahdi adan_12", "Nabil Ahmed_NE-12(104)", "Shihab_11", "Md Tarikul Islam_13", "Emtiaje_11", "Ayman alam_8th", "Enamul Hoque Jewel_11", "Sajir_12", "Tanzim Koushik_10", "Md Rofik Islam_NE-11", "Pranto_10", "MD Shurid_13", "Nahid_6th", "Khan Mahmud Sunny_13", "Saeid_11", "Mubassir Rahman_12", "Saad Chowdhury_12", "Rifat Tamim_12", "Fehazul Islam Sawmiq_11", "Sifat_11", "Rafat Rahman Aronno_11", "Apon_12", "Araf Ahamad_10", "Munna_11", "Md Tanzim Alahi_9th", "Shadab zafir shion_12", "Robiul_12", "Azmaen Galib_12", "Aiman noor_12", "Abu Sadat Al Sabit_13", "Rijon_12th", "Tasin Rahman_8", "Sajjad Hossain Hridoy_NE-13", "Jihad_9th", "Ashim mazumder santo_9th", "Ashraful Islam_10th", "Mehady Hasan_9", "Abrar Tamim_9", "Saadman Zaman Bevore_11th", "Fardeen_9", "Ariful Islam_7", "Farhan Arnab_7", "Ashik Reza_6","Shahriar Nasib_11","Maruf_8","Noman_8"
];

// Assign ~8 players per team (5 teams)
// Bid amounts vary realistically; total per team won't exceed 1000
// Each team has 10 required players so must keep 9*20=180 in reserve initially
const assignments = [
    // teamIndex, bid
    [0, 150], [0, 80], [0, 60], [0, 45], [0, 35], [0, 30], [0, 25], [0, 20],
    [1, 120], [1, 70], [1, 55], [1, 40], [1, 35], [1, 25], [1, 20], [1, 20],
    [2, 100], [2, 90], [2, 60], [2, 40], [2, 30], [2, 25], [2, 20], [2, 20],
    [3, 140], [3, 75], [3, 50], [3, 45], [3, 35], [3, 25], [3, 20], [3, 20],
    [4, 110], [4, 85], [4, 65], [4, 40], [4, 30], [4, 25], [4, 20], [4, 20],
];

let step = 0;
let successCount = 0;
let errorCount = 0;

socket.on('connect', () => {
    console.log('✅ Connected to server');
    console.log(`📋 Submitting ${players.length} bids...\n`);
    sendNext();
});

socket.on('message', data => {
    if (data.type === 'success') {
        successCount++;
        console.log(`  ✔ [${successCount}] ${data.text}`);
    } else if (data.type === 'error') {
        errorCount++;
        console.log(`  ✖ ERROR: ${data.text}`);
    } else {
        console.log(`  ℹ ${data.text}`);
    }
});

socket.on('update', data => {
    // Optionally log balances after each update
});

function sendNext() {
    if (step >= assignments.length || step >= players.length) {
        setTimeout(() => {
            console.log(`\n========== TEST COMPLETE ==========`);
            console.log(`✔ Successful bids : ${successCount}`);
            console.log(`✖ Failed bids     : ${errorCount}`);
            console.log(`📊 Total submitted : ${step}`);
            socket.disconnect();
            process.exit(0);
        }, 500);
        return;
    }

    const player = players[step];
    const [teamIndex, bid] = assignments[step];

    console.log(`→ Bidding: "${player}" → Team ${teamIndex} @ ${bid}`);
    socket.emit('bid', { player, bid: bid.toString(), teamIndex: teamIndex.toString() });

    step++;
    // 400ms between bids to avoid flooding
    setTimeout(sendNext, 400);
}

socket.on('disconnect', () => {
    console.log('\n🔌 Disconnected from server');
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
});
