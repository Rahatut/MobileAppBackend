-- Add related_request_id to Notification table
ALTER TABLE Notification 
ADD COLUMN related_request_id INT,
ADD CONSTRAINT fk_notification_related_request 
FOREIGN KEY (related_request_id) REFERENCES Join_Request(request_id) ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX idx_notification_request ON Notification(related_request_id);
