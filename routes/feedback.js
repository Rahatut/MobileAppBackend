const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Submit feedback
router.post('/submit', async (req, res) => {
  const { ride_id, reviewer_id, reviewee_id, rating, review } = req.body;

  if (!ride_id || !reviewer_id || !reviewee_id || !rating) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const query = `
      INSERT INTO feedback (ride_id, reviewer_id, reviewee_id, rating, review, timestamp)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `;
    await pool.query(query, [ride_id, reviewer_id, reviewee_id, rating, review]);
    res.status(201).json({ message: 'Feedback submitted successfully' });
  } catch (error) {
    console.error('Error submitting feedback:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get feedback for a user
router.get('/:user_id', async (req, res) => {
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