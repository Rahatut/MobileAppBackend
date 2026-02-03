const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Helper function to add payment status
async function addPaymentStatus(client, paymentId, status) {
  await client.query(
    'INSERT INTO Payment_Status_Log (payment_id, status) VALUES ($1, $2)',
    [paymentId, status]
  );
}

// Helper function to get current payment status
async function getCurrentPaymentStatus(client, paymentId) {
  const result = await client.query(
    `SELECT status FROM Payment_Status_Log 
     WHERE payment_id = $1 
     ORDER BY timestamp DESC LIMIT 1`,
    [paymentId]
  );
  return result.rows.length > 0 ? result.rows[0].status : null;
}

// Create a payment record
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { rideId, amount, distance } = req.body;

    if (!rideId || amount === undefined) {
      return res.status(400).json({ error: 'rideId and amount required' });
    }

    await client.query('BEGIN');

    // Verify user is part of the ride
    const rideCheck = await client.query(
      `SELECT r.* FROM Ride r
       LEFT JOIN Join_Request jr ON jr.ride_id = r.ride_id AND jr.partner_id = $1
       WHERE r.ride_id = $2 AND (r.creator_id = $1 OR jr.partner_id = $1)`,
      [req.userId, rideId]
    );

    if (rideCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized for this ride' });
    }

    // Create payment
    const result = await client.query(
      'INSERT INTO Payment (ride_id, payer_id, amount, distance) VALUES ($1, $2, $3, $4) RETURNING *',
      [rideId, req.userId, amount, distance]
    );

    const payment = result.rows[0];

    // Add initial status
    await addPaymentStatus(client, payment.payment_id, 'pending');

    await client.query('COMMIT');

    res.status(201).json({ message: 'Payment created', payment });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create payment' });
  } finally {
    client.release();
  }
});

// Get payments for a ride
router.get('/ride/:rideId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.name, u.username, u.user_uuid,
              (SELECT status FROM Payment_Status_Log WHERE payment_id = p.payment_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Payment p
       JOIN "User" u ON p.payer_id = u.user_id
       WHERE p.ride_id = $1
       ORDER BY p.payment_id DESC`,
      [req.params.rideId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Get user's payments
router.get('/my-payments', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, r.ride_uuid,
              (SELECT status FROM Payment_Status_Log WHERE payment_id = p.payment_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Payment p
       JOIN Ride r ON p.ride_id = r.ride_id
       WHERE p.payer_id = $1
       ORDER BY p.payment_id DESC`,
      [req.userId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Update payment status
router.patch('/:paymentId/status', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { status } = req.body;

    if (!['pending', 'completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await client.query('BEGIN');

    // Verify ownership
    const paymentResult = await client.query(
      'SELECT payer_id FROM Payment WHERE payment_id = $1',
      [req.params.paymentId]
    );

    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (paymentResult.rows[0].payer_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Add status log
    await addPaymentStatus(client, req.params.paymentId, status);

    await client.query('COMMIT');

    res.json({ message: 'Payment status updated', status });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update payment status' });
  } finally {
    client.release();
  }
});

module.exports = router;
