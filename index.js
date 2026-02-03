const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const ridesRoutes = require('./routes/rides');
const joinRequestsRoutes = require('./routes/joinRequests');
const friendsRoutes = require('./routes/friends');
const paymentsRoutes = require('./routes/payments');
const ratingsRoutes = require('./routes/ratings');
const notificationsRoutes = require('./routes/notifications');
const chatRoutes = require('./routes/chat');

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/rides', ridesRoutes);
app.use('/api/join-requests', joinRequestsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/chats', chatRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

