const jwt = require('jsonwebtoken');
const { initFirebaseAdmin } = require('../firebaseAdmin');

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Auth error: Missing or invalid authorization header');
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7);
  console.log('Auth Provider:', process.env.AUTH_PROVIDER);
  console.log('Token received (first 20 chars):', token.substring(0, 20));

  try {
    if (process.env.AUTH_PROVIDER === 'firebase') {
      const admin = initFirebaseAdmin();
      const decoded = await admin.auth().verifyIdToken(token);
      req.userId = decoded.uid;
      console.log('Firebase auth successful, userId:', req.userId);
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    console.log('JWT auth successful, userId:', req.userId);
    return next();
  } catch (err) {
    console.log('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
