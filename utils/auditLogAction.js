// auditLogAction.js
// Utility to log admin actions to standard output to respect db schema
const fs = require('fs');
const path = require('path');

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
  const logMessage = `[${new Date().toISOString()}] AUDIT - Admin: ${adminId} | Action: ${action} | Target: ${targetType}(${targetId} - ${targetName}) | Reason: ${reason} | Sensitive: ${sensitiveAccess}\n`;
  console.log(logMessage.trim());
  try {
    fs.appendFileSync(path.join(__dirname, '../admin_audit.log'), logMessage);
  } catch(e) {
    console.error("Failed to write to audit log file", e);
  }
}

module.exports = auditLogAction;
