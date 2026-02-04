const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.user_uuid, u.username, u.name, u.gender, u.profile_bio, 
              u.avg_rating, u.phone, u.avatar_url, u.total_rides, u.created_at,
              u.university, u.department, u.address, u.fb,
              a.email, a.is_verified
       FROM "User" u
       LEFT JOIN Auth a ON u.user_id = a.user_id
       WHERE u.user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Get user profile by ID or UUID
router.get('/:identifier/ride-stats', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isUuid = identifier.includes('-');
    const isNumeric = /^\d+$/.test(identifier);

    const userIdQuery = isUuid
      ? 'SELECT user_id FROM "User" WHERE user_uuid = $1'
      : isNumeric
        ? 'SELECT user_id FROM "User" WHERE user_id = $1'
        : 'SELECT user_id FROM "User" WHERE username = $1';

    const userResult = await pool.query(userIdQuery, [identifier]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].user_id;

    const createdResult = await pool.query(
      'SELECT COUNT(*) as created_count FROM Ride WHERE creator_id = $1',
      [userId]
    );

    const joinedResult = await pool.query(
      `SELECT COUNT(*) as joined_count
       FROM Join_Request jr
       WHERE jr.partner_id = $1
       AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
      [userId]
    );

    res.json({
      createdCount: parseInt(createdResult.rows[0].created_count, 10),
      joinedCount: parseInt(joinedResult.rows[0].joined_count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ride stats' });
  }
});

router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    const isUuid = identifier.includes('-');
    const isNumeric = /^\d+$/.test(identifier);
    const query = isUuid 
      ? `SELECT u.user_id, u.user_uuid, u.username, u.name, u.gender, u.profile_bio, u.avg_rating, u.avatar_url, u.total_rides,
               u.university, u.department, u.address, u.fb, u.phone, a.email
         FROM "User" u
         LEFT JOIN Auth a ON u.user_id = a.user_id
         WHERE u.user_uuid = $1`
      : isNumeric
        ? `SELECT u.user_id, u.user_uuid, u.username, u.name, u.gender, u.profile_bio, u.avg_rating, u.avatar_url, u.total_rides,
                 u.university, u.department, u.address, u.fb, u.phone, a.email
           FROM "User" u
           LEFT JOIN Auth a ON u.user_id = a.user_id
           WHERE u.user_id = $1`
        : `SELECT u.user_id, u.user_uuid, u.username, u.name, u.gender, u.profile_bio, u.avg_rating, u.avatar_url, u.total_rides,
                 u.university, u.department, u.address, u.fb, u.phone, a.email
           FROM "User" u
           LEFT JOIN Auth a ON u.user_id = a.user_id
           WHERE u.username = $1`;

    const result = await pool.query(query, [identifier]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user profile (PUT)
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { name, username, phone, gender, profileBio, avatarUrl, university, department, address, fb } = req.body;

    const result = await pool.query(
      `UPDATE "User" 
       SET name = COALESCE($1, name), 
           username = COALESCE($2, username), 
           phone = COALESCE($3, phone), 
           gender = COALESCE($4, gender), 
           profile_bio = COALESCE($5, profile_bio), 
           avatar_url = COALESCE($6, avatar_url),
           university = COALESCE($7, university),
           department = COALESCE($8, department),
           address = COALESCE($9, address),
           fb = COALESCE($10, fb),
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $11 
       RETURNING *`,
      [name, username, phone, gender, profileBio, avatarUrl, university, department, address, fb, req.userId]
    );

    res.json({ message: 'Profile updated', user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update user profile (PATCH) - alias for PUT
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const { name, username, phone, gender, profileBio, avatarUrl, university, department, address, fb } = req.body;

    const result = await pool.query(
      `UPDATE "User" 
       SET name = COALESCE($1, name), 
           username = COALESCE($2, username), 
           phone = COALESCE($3, phone), 
           gender = COALESCE($4, gender), 
           profile_bio = COALESCE($5, profile_bio), 
           avatar_url = COALESCE($6, avatar_url),
           university = COALESCE($7, university),
           department = COALESCE($8, department),
           address = COALESCE($9, address),
           fb = COALESCE($10, fb),
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $11 
       RETURNING *`,
      [name, username, phone, gender, profileBio, avatarUrl, university, department, address, fb, req.userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get user's friends
router.get('/me/friends', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.user_uuid, u.username, u.name, u.avatar_url, u.avg_rating
       FROM Friend f
       JOIN "User" u ON (f.user2_id = u.user_id OR f.user1_id = u.user_id)
       WHERE (f.user1_id = $1 OR f.user2_id = $1) AND u.user_id != $1`,
      [req.userId]
    );

    res.json({ friends: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch friends' });
  }
});

// Search users
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search term too short (minimum 2 characters)' });
    }

    const result = await pool.query(
      `SELECT user_id, user_uuid, username, name, gender, profile_bio, avg_rating, avatar_url, total_rides, university, department, address, fb
       FROM "User"
       WHERE name ILIKE $1 OR username ILIKE $1
       ORDER BY name ASC
       LIMIT 20`,
      [`%${q}%`]
    );

    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get user ratings
router.get('/:userId/ratings', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      `SELECT r.*, ru.name as rater_name, ru.username as rater_username, ru.avatar_url as rater_avatar
       FROM Rating r
       JOIN "User" ru ON r.rater_id = ru.user_id
       WHERE r.rated_user_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );

    const average = result.rows.length > 0
      ? (result.rows.reduce((sum, r) => sum + r.rating, 0) / result.rows.length).toFixed(2)
      : 0;

    res.json({ 
      ratings: result.rows, 
      average: parseFloat(average),
      totalRatings: result.rows.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

module.exports = router;
