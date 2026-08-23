const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  name: String,
  category: String,
  basePrice: Number,
  mediaUrl: String, // Cloudinary link for .png/.mp4
  mediaType: String, // 'image' or 'video'
  status: { type: String, default: 'unsold' },
  soldTo: String,
  soldPrice: Number
});

const tournamentSchema = new mongoose.Schema({
  tournamentCode: { type: String, required: true, unique: true },
  adminUsername: { type: String, required: true },
  adminPassword: { type: String, required: true },
  title: String,
  minPlayersPerTeam: Number,
  maxPlayersPerTeam: Number,
  teams: [{ name: String, budget: Number, logoUrl: String }],
  players: [playerSchema]
});

module.exports = mongoose.model('Tournament', tournamentSchema);
