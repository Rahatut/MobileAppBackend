require('dotenv').config();
const pool = require('./db/pool');

async function testAuth(userId) {
  const result = await pool.query(
      `SELECT
         CASE 
           WHEN r.creator_id = $2 THEN 'creator'
           WHEN jr.request_id IS NOT NULL THEN COALESCE(
             (SELECT status::text 
              FROM Request_Status_Log 
              WHERE request_id = jr.request_id 
              ORDER BY timestamp DESC LIMIT 1),
             jr.status::text
           )
           ELSE NULL
         END as membership_status,
         CASE
           WHEN jr.request_id IS NOT NULL THEN EXISTS (
             SELECT 1 FROM Request_Status_Log 
             WHERE request_id = jr.request_id AND status = 'accepted'
           )
           ELSE FALSE
         END as was_ever_accepted
       FROM Ride r
       LEFT JOIN Join_Request jr ON jr.ride_id = r.ride_id AND jr.partner_id = $2
       WHERE r.ride_id = $1`,
      [204, userId]
    );
    console.log(`User ${userId} DB rows:`, result.rows.length);
}

testAuth(9).then(() => testAuth(10)).then(() => process.exit());
