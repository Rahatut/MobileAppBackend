const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Helper function to add friend request status
async function addFriendRequestStatus(client, requestId, status) {
  await client.query(
    'INSERT INTO Friend_Request_Status_Log (friend_request_id, status) VALUES ($1, $2)',
    [requestId, status]
  );
}

// Helper function to get current friend request status
async function getCurrentFriendRequestStatus(client, requestId) {
  const result = await client.query(
    `SELECT status FROM Friend_Request_Status_Log 
     WHERE friend_request_id = $1 
     ORDER BY timestamp DESC LIMIT 1`,
    [requestId]
  );
  return result.rows.length > 0 ? result.rows[0].status : null;
}

// Send friend request
router.post('/request', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId required' });
    }

    if (receiverId === req.userId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }

    await client.query('BEGIN');

    // Check if already friends
    const friendCheck = await client.query(
      'SELECT * FROM Friend WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)',
      [req.userId, receiverId]
    );

    if (friendCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already friends' });
    }

    // Check if request already exists
    const requestCheck = await client.query(
      'SELECT * FROM Friend_Request WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)',
      [req.userId, receiverId]
    );

    if (requestCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Friend request already exists' });
    }

    // Create friend request
    const result = await client.query(
      'INSERT INTO Friend_Request (sender_id, receiver_id) VALUES ($1, $2) RETURNING *',
      [req.userId, receiverId]
    );

    const friendRequest = result.rows[0];

    // Add initial status
    await addFriendRequestStatus(client, friendRequest.request_id, 'pending');

    await client.query('COMMIT');

    res.status(201).json({ message: 'Friend request sent', friendRequest });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to send friend request' });
  } finally {
    client.release();
  }
});

// Get received friend requests
router.get('/requests/received', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fr.*, u.user_id, u.user_uuid, u.username, u.name, u.avatar_url, u.avg_rating,
              (SELECT status FROM Friend_Request_Status_Log WHERE friend_request_id = fr.request_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Friend_Request fr
       JOIN "User" u ON fr.sender_id = u.user_id
       WHERE fr.receiver_id = $1
       AND (SELECT status FROM Friend_Request_Status_Log WHERE friend_request_id = fr.request_id ORDER BY timestamp DESC LIMIT 1) = 'pending'`,
      [req.userId]
    );

    res.json({ friendRequests: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch friend requests' });
  }
});

// Get sent friend requests
router.get('/requests/sent', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fr.*, u.user_id, u.user_uuid, u.username, u.name, u.avatar_url, u.avg_rating,
              (SELECT status FROM Friend_Request_Status_Log WHERE friend_request_id = fr.request_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Friend_Request fr
       JOIN "User" u ON fr.receiver_id = u.user_id
       WHERE fr.sender_id = $1`,
      [req.userId]
    );

    res.json({ friendRequests: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sent friend requests' });
  }
});

// Accept friend request
router.patch('/request/:requestId/accept', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get friend request
    const requestResult = await client.query(
      'SELECT * FROM Friend_Request WHERE request_id = $1',
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Friend request not found' });
    }

    const request = requestResult.rows[0];

    if (request.receiver_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Update status
    await addFriendRequestStatus(client, req.params.requestId, 'accepted');

    // Add to friends table (ensure smaller user_id is user1_id)
    const user1Id = Math.min(request.sender_id, request.receiver_id);
    const user2Id = Math.max(request.sender_id, request.receiver_id);

    await client.query(
      'INSERT INTO Friend (user1_id, user2_id) VALUES ($1, $2)',
      [user1Id, user2Id]
    );

    await client.query('COMMIT');

    res.json({ message: 'Friend request accepted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to accept friend request' });
  } finally {
    client.release();
  }
});

// Reject friend request
router.patch('/request/:requestId/reject', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get friend request
    const requestResult = await client.query(
      'SELECT * FROM Friend_Request WHERE request_id = $1',
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Friend request not found' });
    }

    const request = requestResult.rows[0];

    if (request.receiver_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Update status
    await addFriendRequestStatus(client, req.params.requestId, 'rejected');

    await client.query('COMMIT');

    res.json({ message: 'Friend request rejected' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to reject friend request' });
  } finally {
    client.release();
  }
});

// Remove friend
router.delete('/:friendId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM Friend WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1) RETURNING *',
      [req.userId, req.params.friendId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    res.json({ message: 'Friend removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

module.exports = router;
