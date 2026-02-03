const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { email, password, name, username, phone, gender, university, department, address, fb } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    await client.query('BEGIN');

    // Create user
    const userResult = await client.query(
      'INSERT INTO "User" (name, username, phone, gender, university, department, address, fb) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING user_id, user_uuid, name, username, gender, phone, university, department, address, fb',
      [name, username, phone, gender, university, department, address, fb]
    );

    const { user_id, user_uuid } = userResult.rows[0];
    const userData = userResult.rows[0];

    // Hash password and create auth
    const hashedPassword = await bcrypt.hash(password, 10);
    await client.query(
      'INSERT INTO Auth (user_id, email, password_hash, is_verified) VALUES ($1, $2, $3, $4)',
      [user_id, email, hashedPassword, false]
    );

    await client.query('COMMIT');

    const token = jwt.sign({ userId: user_id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'User registered successfully',
      userId: user_id,
      userUuid: user_uuid,
      token,
      user: {
        ...userData,
        email,
        is_verified: false
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT a.user_id, a.password_hash, u.user_uuid FROM Auth a JOIN "User" u ON a.user_id = u.user_id WHERE a.email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await pool.query('UPDATE Auth SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);

    const token = jwt.sign({ userId: user.user_id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      userId: user.user_id,
      userUuid: user.user_uuid,
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// OAuth login (Facebook/Google)
router.post('/oauth', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { email, name, provider, providerId } = req.body;

    if (!email || !provider) {
      return res.status(400).json({ error: 'Email and provider required' });
    }

    await client.query('BEGIN');

    // Check if user exists
    let result = await client.query(
      'SELECT a.user_id, u.user_uuid FROM Auth a JOIN "User" u ON a.user_id = u.user_id WHERE a.email = $1',
      [email]
    );

    let userId, userUuid;

    if (result.rows.length > 0) {
      // User exists
      userId = result.rows[0].user_id;
      userUuid = result.rows[0].user_uuid;
      
      // Update last login
      await client.query('UPDATE Auth SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1', [userId]);
    } else {
      // Create new user
      const userResult = await client.query(
        'INSERT INTO "User" (name) VALUES ($1) RETURNING user_id, user_uuid',
        [name]
      );
      
      userId = userResult.rows[0].user_id;
      userUuid = userResult.rows[0].user_uuid;

      // Create auth with OAuth provider
      await client.query(
        'INSERT INTO Auth (user_id, email, auth_provider, is_verified) VALUES ($1, $2, $3, $4)',
        [userId, email, provider, true]
      );
    }

    await client.query('COMMIT');

    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'OAuth login successful',
      userId,
      userUuid,
      token,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'OAuth login failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
