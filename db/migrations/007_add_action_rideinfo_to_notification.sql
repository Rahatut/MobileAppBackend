-- Add action and ride_info columns to Notification table for richer notification payloads
ALTER TABLE Notification
ADD COLUMN action JSONB,
ADD COLUMN ride_info JSONB;
