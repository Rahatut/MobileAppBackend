require('dotenv').config();
const pool = require('./db/pool');

async function testAuth(userId) {
  const client = await pool.connect();
  try {
    const chatId = 36;
    
    const chatResult = await client.query('SELECT chat_id, type, ride_id FROM Chat WHERE chat_id = $1', [chatId]);
    const chat = chatResult.rows[0];

    const result = await client.query(
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
      [chat.ride_id, userId]
    );

    let memberStatusStr = null;
    if (result.rows.length > 0) {
      const row = result.rows[0];
      if (row.membership_status === 'creator') memberStatusStr = 'creator';
      else if (row.membership_status === 'accepted') memberStatusStr = 'active_passenger';
      else if (row.was_ever_accepted) memberStatusStr = 'removed_passenger';
    }
    
    console.log(`User ${userId} - DB row:`, result.rows[0], '=> memberStatus:', memberStatusStr);
    
  } finally {
    client.release();
  }
}

async function run() {
  await testAuth(9);
  await testAuth(10);
  process.exit();
}
run();
