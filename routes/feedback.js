const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

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
// ...existing code...

// Submit feedback (must be above parameterized routes)
router.post('/submit', async (req, res) => {
  console.log('POST /feedback/submit hit!');
  console.log('Request body:', req.body);
  const { ride_id, reviewer_id, reviewee_id, rating, review } = req.body;

  if (!ride_id || !reviewer_id || !reviewee_id || !rating) {
    if (!res.headersSent) res.status(400).json({ error: 'Missing required fields' });
    else console.error('Response already sent for missing fields!');
    return;
  }

  try {
    const query = `
      INSERT INTO feedback (ride_id, reviewer_id, reviewee_id, rating, review, timestamp)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `;
    await pool.query(query, [ride_id, reviewer_id, reviewee_id, rating, review]);
    if (!res.headersSent) res.status(201).json({ message: 'Feedback submitted successfully' });
    else console.error('Response already sent after DB insert!');
  } catch (error) {
    console.error('Error submitting feedback:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else console.error('Response already sent after error!');
  }
});

// Get feedback for a user (use /user/:user_id for clarity)
router.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    const query = `
      SELECT * FROM feedback WHERE reviewee_id = $1 ORDER BY timestamp DESC
    `;
    const { rows } = await pool.query(query, [user_id]);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;