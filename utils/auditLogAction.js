// auditLogAction.js
// Utility to log admin actions with reason, before/after state, and sensitive access flag
const pool = require('../db/pool');

async function auditLogAction({
  adminId,
  action,
  targetType,
  targetId,
  targetName,
  reason,
  beforeState,
  afterState,
  sensitiveAccess = false,
  ipAddress,
}) {
  await pool.query(
    `INSERT INTO Audit_Log (action, actor_user_id, target_type, target_id, target_name, reason, before_state, after_state, sensitive_access, ip_address, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [action, adminId, targetType, targetId, targetName, reason, beforeState, afterState, sensitiveAccess, ipAddress]
  );
}

module.exports = auditLogAction;
