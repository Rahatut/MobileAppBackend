const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

// Get average feedback rating for a user (reviewee)
router.get('/user/:user_id/average', async (req, res) => {
  const { user_id } = req.params;
  try {
    const query = `SELECT AVG(rating) as avg_rating, COUNT(*) as total_ratings FROM feedback WHERE reviewee_id = $1`;
    const { rows } = await pool.query(query, [user_id]);
    res.status(200).json({
      avgRating: rows[0].avg_rating ? parseFloat(rows[0].avg_rating).toFixed(2) : null,
      totalRatings: parseInt(rows[0].total_ratings)
    });
  } catch (error) {
    console.error('Error fetching average feedback:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get feedback submitted by a reviewer for a ride (auth-protected)
router.get('/ride/:rideId/reviewer/:reviewerId', authMiddleware, async (req, res) => {
  const { rideId, reviewerId } = req.params;

  if (Number(req.userId) !== Number(reviewerId)) {
    return res.status(403).json({ error: 'Not authorized to view these submissions' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, ride_id, reviewer_id, reviewee_id, rating, review, timestamp
       FROM feedback
       WHERE ride_id = $1 AND reviewer_id = $2
       ORDER BY timestamp DESC`,
      [rideId, reviewerId]
    );

    return res.status(200).json({ feedback: rows });
  } catch (error) {
    console.error('Error fetching reviewer feedback for ride:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit feedback (must be above parameterized routes)
router.post('/submit', authMiddleware, async (req, res) => {
  const reviewerIdFromToken = Number(req.userId);
  const {
    ride_id,
    rideId,
    reviewee_id,
    revieweeId,
    rating,
    review,
  } = req.body;

  const normalizedRideId = Number(ride_id ?? rideId);
  const normalizedRevieweeId = Number(reviewee_id ?? revieweeId);
  const normalizedRating = Number(rating);
  const normalizedReview = typeof review === 'string' ? review.trim() : null;

  if (!Number.isInteger(normalizedRideId) || !Number.isInteger(normalizedRevieweeId) || !Number.isFinite(normalizedRating)) {
    return res.status(400).json({ error: 'rideId, revieweeId and rating are required' });
  }

  if (normalizedRating < 1 || normalizedRating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  if (reviewerIdFromToken === normalizedRevieweeId) {
    return res.status(400).json({ error: 'Cannot review yourself' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const participationCheck = await client.query(
      `SELECT r.ride_id
       FROM Ride r
       LEFT JOIN Join_Request reviewer_jr ON reviewer_jr.ride_id = r.ride_id AND reviewer_jr.partner_id = $1
       LEFT JOIN Join_Request reviewee_jr ON reviewee_jr.ride_id = r.ride_id AND reviewee_jr.partner_id = $2
       WHERE r.ride_id = $3
         AND (
           r.creator_id = $1 OR (
             reviewer_jr.partner_id = $1
             AND (SELECT status FROM Request_Status_Log WHERE request_id = reviewer_jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'
           )
         )
         AND (
           r.creator_id = $2 OR (
             reviewee_jr.partner_id = $2
             AND (SELECT status FROM Request_Status_Log WHERE request_id = reviewee_jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'
           )
         )
       LIMIT 1`,
      [reviewerIdFromToken, normalizedRevieweeId, normalizedRideId]
    );

    if (participationCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Both users must be part of this ride' });
    }

    const duplicateCheck = await client.query(
      'SELECT id FROM feedback WHERE ride_id = $1 AND reviewer_id = $2 AND reviewee_id = $3 LIMIT 1',
      [normalizedRideId, reviewerIdFromToken, normalizedRevieweeId]
    );

    if (duplicateCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Feedback already submitted for this user in this ride' });
    }

    const insertResult = await client.query(
      `INSERT INTO feedback (ride_id, reviewer_id, reviewee_id, rating, review, timestamp)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [normalizedRideId, reviewerIdFromToken, normalizedRevieweeId, normalizedRating, normalizedReview || null]
    );

    const avgResult = await client.query(
      `SELECT AVG(rating) AS avg_rating
       FROM feedback
       WHERE reviewee_id = $1`,
      [normalizedRevieweeId]
    );

    const avgRating = avgResult.rows[0]?.avg_rating ? Number(avgResult.rows[0].avg_rating).toFixed(2) : null;
    if (avgRating !== null) {
      await client.query('UPDATE "User" SET avg_rating = $1 WHERE user_id = $2', [avgRating, normalizedRevieweeId]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Feedback submitted successfully', feedback: insertResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error submitting feedback:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get feedback for a user (use /user/:user_id for clarity)
router.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    const query = `
      SELECT
        f.id,
        f.ride_id,
        f.reviewer_id,
        f.reviewee_id,
        f.rating,
        f.review,
        f.timestamp,
        reviewer.name AS reviewer_name,
        reviewer.username AS reviewer_username,
        reviewer.avatar_url AS reviewer_avatar,
        r.ride_uuid
      FROM feedback f
      JOIN "User" reviewer ON reviewer.user_id = f.reviewer_id
      LEFT JOIN Ride r ON r.ride_id = f.ride_id
      WHERE f.reviewee_id = $1
      ORDER BY f.timestamp DESC
    `;
    const { rows } = await pool.query(query, [user_id]);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;