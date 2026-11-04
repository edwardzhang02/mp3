// Load required packages
var mongoose = require('mongoose');

// Define our user schema
var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    // _id values of the *pending* tasks assigned to this user
    pendingTasks: { type: [String], default: [] },
    // Set by the server on creation; never changes afterwards
    dateCreated: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);
