// test-fill.js — Auto-fills ~40 bids to test the NPL Auction system
// Run with: node test-fill.js

const { io } = require('socket.io-client');

const socket = io('http://localhost:3000');

// Players from admin.html (first 40)
const players = [
   "Abdur Rahman Bhuiyan (Faysal)_11", "Abdullah Khubaib_10", "Abdullah Wasif_12", "Abu Sadat Ali Sabit_13", "Abu Talha Nowshad_12", "Abrar Rafi_10", "Abrar Tamim_09", "Aiman Noor_12", "Apon Mia_12", "Araf Ahmad_10", "Ashikur Rahman_10", "Ashraful Islam_10", "Atiqur Rahman_10", "Ayman Alam_08", "Azmaen Galib_12", "Badhon Rahman_10", "Enamul Haque Jewel_11", "Emtiaje_11", "Farhan Labib_08", "Fardeen Hassan_09", "Foyez Ahmed_13", "Foyzul Rijon_12", "Hafij_11", "Ibrahim khalil_08", "Illias Mahdi Adan_12", "Joyonto Sorkar_09", "Khan Mahmud Sunny_13", "Krishna Chandra Bagh_11", "Mahir Daiyan_12", "Md. Masum_08", "Md. Shurid_13", "Meharub Hossain Srijon_12", "Mehady Hasan_09", "Mehedi Hasan Jihad_09", "Mir Dider Ali Rakib_04", "Monjurul Imam Tonmoy_08", "Mubassir Rahman Alif_12", "Nasif Al Shahab_10", "Nazmus Saeid_11", "Nur e Alam Patwari_03", "Pranto Pall_10", "Rahat Hasan_07", "Rifat Tamim_12", "Rofik Islam_11", "Saad Chowdhury_12", "Sadman Sakib_12", "Samin Yeasir_13", "Sayed Ahmed Rahat_07", "Sazzad Hossain Hridoy_13", "Shahriar Nasib_11", "Shahriar Sajir_12", "Shawon_11", "Shihab_11", "Sifatuzzaman Sium_12", "Sudipto Mondol Mahin_12", "Tahsin Ahmed Tamim_11", "Tamim Bin Abdullah_09", "Tanzim Koushik_10", "Tasin Rahman_08", "Tarikul Islam_13", "Towhid Akram_08", "Zayed_08","Kabyo_12","Amit_12","Nabil_12","Morsalin_12"
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
