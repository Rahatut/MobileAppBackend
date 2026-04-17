-- Migration: Add state and closure fields to Chat, status to Chat_Participants
ALTER TABLE Chat ADD COLUMN IF NOT EXISTS state VARCHAR(16) DEFAULT 'locked'; -- locked | active | read_only | archived
ALTER TABLE Chat ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
ALTER TABLE Chat ADD COLUMN IF NOT EXISTS closed_reason VARCHAR(128);
ALTER TABLE Chat_Participants ADD COLUMN IF NOT EXISTS status VARCHAR(16) DEFAULT 'active'; -- active | removed | left | blocked
