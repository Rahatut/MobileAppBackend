const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Submit a rating
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { rideId, rateeId, rating } = req.body;

    if (!rideId || !rateeId || !rating) {
      return res.status(400).json({ error: 'rideId, rateeId, and rating required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    if (req.userId === rateeId) {
      return res.status(400).json({ error: 'Cannot rate yourself' });
    }

    await client.query('BEGIN');

    // Verify both users were part of the ride
    const rideCheck = await client.query(
      `SELECT r.creator_id FROM Ride r
       LEFT JOIN Join_Request jr1 ON jr1.ride_id = r.ride_id AND jr1.partner_id = $1
       LEFT JOIN Join_Request jr2 ON jr2.ride_id = r.ride_id AND jr2.partner_id = $2
       WHERE r.ride_id = $3 
       AND (r.creator_id = $1 OR jr1.partner_id = $1)
       AND (r.creator_id = $2 OR jr2.partner_id = $2)`,
      [req.userId, rateeId, rideId]
    );

    if (rideCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Users were not part of this ride' });
    }

    // Check if already rated
    const existingRating = await client.query(
      'SELECT * FROM Rating WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3',
      [rideId, req.userId, rateeId]
    );

    if (existingRating.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already rated this user for this ride' });
    }

    // Insert rating
    const result = await client.query(
      'INSERT INTO Rating (ride_id, rater_id, ratee_id, rating) VALUES ($1, $2, $3, $4) RETURNING *',
      [rideId, req.userId, rateeId, rating]
    );

    // Update user's average rating
    const avgResult = await client.query(
      'SELECT AVG(rating) as avg_rating FROM Rating WHERE ratee_id = $1',
      [rateeId]
    );

    await client.query(
      'UPDATE "User" SET avg_rating = $1 WHERE user_id = $2',
      [parseFloat(avgResult.rows[0].avg_rating).toFixed(2), rateeId]
    );

    await client.query('COMMIT');

    res.status(201).json({ message: 'Rating submitted', rating: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to submit rating' });
  } finally {
    client.release();
  }
});

// Get ratings for a user
router.get('/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name, u.username, u.avatar_url, ride.ride_uuid
       FROM Rating r
       JOIN "User" u ON r.rater_id = u.user_id
       JOIN Ride ride ON r.ride_id = ride.ride_id
       WHERE r.ratee_id = $1
       ORDER BY r.timestamp DESC`,
      [req.params.userId]
    );

    const avgResult = await pool.query(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as total_ratings FROM Rating WHERE ratee_id = $1',
      [req.params.userId]
    );

    res.json({
      ratings: result.rows,
      avgRating: avgResult.rows[0].avg_rating ? parseFloat(avgResult.rows[0].avg_rating).toFixed(2) : null,
      totalRatings: parseInt(avgResult.rows[0].total_ratings),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// Get ratings for a ride
router.get('/ride/:rideId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
              rater.name as rater_name, rater.username as rater_username,
              ratee.name as ratee_name, ratee.username as ratee_username
       FROM Rating r
       JOIN "User" rater ON r.rater_id = rater.user_id
       JOIN "User" ratee ON r.ratee_id = ratee.user_id
       WHERE r.ride_id = $1
       ORDER BY r.timestamp DESC`,
      [req.params.rideId]
    );

    res.json({ ratings: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

module.exports = router;
