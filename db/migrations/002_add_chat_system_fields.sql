-- Migration: Add Chat System Fields
-- Date: 2026-02-03
-- Description: Add missing fields to Chat and Message tables for proper functioning

-- Add missing fields to Chat table if they don't exist
ALTER TABLE Chat
ADD COLUMN IF NOT EXISTS created_by INT REFERENCES "User"(user_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Add missing fields to Message table if they don't exist
ALTER TABLE Message
ADD COLUMN IF NOT EXISTS media_url TEXT,
ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_chat_created_by ON Chat(created_by);
CREATE INDEX IF NOT EXISTS idx_chat_created_at ON Chat(created_at);
CREATE INDEX IF NOT EXISTS idx_message_chat_id ON Message(chat_id);
CREATE INDEX IF NOT EXISTS idx_message_sender_id ON Message(sender_id);
CREATE INDEX IF NOT EXISTS idx_message_is_read ON Message(is_read);
CREATE INDEX IF NOT EXISTS idx_message_created_at ON Message(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON Chat_Participants(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_participant_id ON Chat_Participants(participant_id);

-- Update trigger to set updated_at on Chat updates
CREATE OR REPLACE FUNCTION update_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_chat_timestamp_trigger ON Chat;

CREATE TRIGGER update_chat_timestamp_trigger
BEFORE UPDATE ON Chat
FOR EACH ROW
EXECUTE FUNCTION update_chat_timestamp();

-- Update trigger to set updated_at on Message updates
CREATE OR REPLACE FUNCTION update_message_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_message_timestamp_trigger ON Message;

CREATE TRIGGER update_message_timestamp_trigger
BEFORE UPDATE ON Message
FOR EACH ROW
EXECUTE FUNCTION update_message_timestamp();
