-- =========================
-- DROP EXISTING OBJECTS
-- =========================
DROP TABLE IF EXISTS Rating CASCADE;
DROP TABLE IF EXISTS Payment_Status_Log CASCADE;
DROP TABLE IF EXISTS Payment CASCADE;
DROP TABLE IF EXISTS Message CASCADE;
DROP TABLE IF EXISTS Chat_Participants CASCADE;
DROP TABLE IF EXISTS Chat CASCADE;
DROP TABLE IF EXISTS Request_Status_Log CASCADE;
DROP TABLE IF EXISTS Join_Request CASCADE;
DROP TABLE IF EXISTS Ride_Status_Log CASCADE;
DROP TABLE IF EXISTS Ride CASCADE;
DROP TABLE IF EXISTS Location_Info CASCADE;
DROP TABLE IF EXISTS Friend_Request_Status_Log CASCADE;
DROP TABLE IF EXISTS Friend_Request CASCADE;
DROP TABLE IF EXISTS Friend CASCADE;
DROP TABLE IF EXISTS Auth CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;

DROP TYPE IF EXISTS chat_role_enum CASCADE;
DROP TYPE IF EXISTS chat_type_enum CASCADE;
DROP TYPE IF EXISTS payment_status_enum CASCADE;
DROP TYPE IF EXISTS request_status_enum CASCADE;
DROP TYPE IF EXISTS ride_status_enum CASCADE;
DROP TYPE IF EXISTS ride_provider_enum CASCADE;
DROP TYPE IF EXISTS transport_mode_enum CASCADE;
DROP TYPE IF EXISTS auth_provider_enum CASCADE;
DROP TYPE IF EXISTS gender_enum CASCADE;

-- =========================
-- EXTENSIONS
-- =========================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================
-- ENUM TYPES
-- =========================
CREATE TYPE gender_enum AS ENUM ('male', 'female', 'other');
CREATE TYPE auth_provider_enum AS ENUM ('facebook', 'google');
CREATE TYPE ride_status_enum AS ENUM ('unactive', 'started', 'cancelled', 'completed', 'expired');
CREATE TYPE request_status_enum AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
CREATE TYPE payment_status_enum AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE chat_type_enum AS ENUM ('private', 'group', 'ride');
CREATE TYPE chat_role_enum AS ENUM ('creator', 'partner', 'friend', 'requester');
CREATE TYPE transport_mode_enum AS ENUM ('Car', 'CNG', 'Bus', 'Bike');
CREATE TYPE ride_provider_enum AS ENUM ('Private', 'Uber', 'Pathao', 'Other');

-- =========================
-- USER
-- =========================
CREATE TABLE "User" (
    user_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE,
    name VARCHAR(100),
    gender gender_enum,
    profile_bio VARCHAR(255),
    avg_rating DECIMAL(3,2),
    phone VARCHAR(20),
    avatar_url VARCHAR(500),
    total_rides INT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    university VARCHAR(255),
    department VARCHAR(255),
    address VARCHAR(500),
    fb VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- AUTH
-- =========================
CREATE TABLE Auth (
    auth_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INT NOT NULL,
    password_hash VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    auth_provider auth_provider_enum,
    last_login TIMESTAMP,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_auth_user
        FOREIGN KEY (user_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- FRIEND
-- =========================
CREATE TABLE Friend (
    user1_id INT NOT NULL,
    user2_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user1_id, user2_id),

    CONSTRAINT fk_friend_user1 FOREIGN KEY (user1_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_user2 FOREIGN KEY (user2_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- FRIEND REQUEST
-- =========================
CREATE TABLE Friend_Request (
    request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    status_id INT,
    request_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),

    CONSTRAINT fk_fr_sender FOREIGN KEY (sender_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_fr_receiver FOREIGN KEY (receiver_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Friend_Request_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    friend_request_id INT NOT NULL,
    status request_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_fr_log
        FOREIGN KEY (friend_request_id) REFERENCES Friend_Request(request_id) ON DELETE CASCADE
);

-- =========================
-- LOCATION INFO
-- =========================
CREATE TABLE Location_Info (
    location_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(255),
    address VARCHAR(255),
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6)
);

-- =========================
-- RIDE
-- =========================
CREATE TABLE Ride (
    ride_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id INT NOT NULL,
    start_location_id INT,
    dest_location_id INT,
    status_log_id INT,
    ride_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    route_polyline TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    start_time TIMESTAMP,
    gender_preference gender_enum,
    preference_notes VARCHAR(255),
    transport_mode transport_mode_enum,
    ride_provider ride_provider_enum,
    fare DECIMAL(10,2),
    available_seats INT,

    CONSTRAINT fk_ride_creator FOREIGN KEY (creator_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_ride_start FOREIGN KEY (start_location_id) REFERENCES Location_Info(location_id),
    CONSTRAINT fk_ride_dest FOREIGN KEY (dest_location_id) REFERENCES Location_Info(location_id)
);

CREATE TABLE Ride_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    status ride_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_ride_status FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE
);

-- =========================
-- JOIN REQUEST
-- =========================
CREATE TABLE Join_Request (
    request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    partner_id INT NOT NULL,
    start_location_id INT,
    dest_location_id INT,
    status_id INT,
    request_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    route_polyline TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_jr_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_jr_user FOREIGN KEY (partner_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_jr_start FOREIGN KEY (start_location_id) REFERENCES Location_Info(location_id),
    CONSTRAINT fk_jr_dest FOREIGN KEY (dest_location_id) REFERENCES Location_Info(location_id)
);

CREATE TABLE Request_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id INT NOT NULL,
    status request_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_request_status
        FOREIGN KEY (request_id) REFERENCES Join_Request(request_id) ON DELETE CASCADE
);

-- =========================
-- CHAT
-- =========================
CREATE TABLE Chat (
    chat_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT,
    chat_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    type chat_type_enum,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_chat_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE
);

CREATE TABLE Chat_Participants (
    chat_id INT NOT NULL,
    participant_id INT NOT NULL,
    role chat_role_enum,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, participant_id),

    CONSTRAINT fk_cp_chat FOREIGN KEY (chat_id) REFERENCES Chat(chat_id) ON DELETE CASCADE,
    CONSTRAINT fk_cp_user FOREIGN KEY (participant_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Message (
    message_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_id INT NOT NULL,
    message_uuid UUID DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    content TEXT,
    media_url TEXT,
    is_read BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_msg_chat FOREIGN KEY (chat_id) REFERENCES Chat(chat_id) ON DELETE CASCADE,
    CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- NOTIFICATION
-- =========================
CREATE TABLE Notification (
    notification_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    related_user_id INT,
    related_ride_id INT,
    related_request_id INT,
    ride_uuid UUID,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_notification_related_user FOREIGN KEY (related_user_id) REFERENCES "User"(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_notification_related_ride FOREIGN KEY (related_ride_id) REFERENCES Ride(ride_id) ON DELETE SET NULL,
    CONSTRAINT fk_notification_related_request FOREIGN KEY (related_request_id) REFERENCES Join_Request(request_id) ON DELETE SET NULL
);

-- =========================
-- PAYMENT
-- =========================
CREATE TABLE Payment (
    payment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    payer_id INT NOT NULL,
    payment_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    amount DECIMAL(10,2),
    distance DECIMAL(6,2),

    CONSTRAINT fk_payment_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_user FOREIGN KEY (payer_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Payment_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_id INT NOT NULL,
    status payment_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_status
        FOREIGN KEY (payment_id) REFERENCES Payment(payment_id) ON DELETE CASCADE
);

-- =========================
-- RATING
-- =========================
CREATE TABLE Rating (
    rating_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    rater_id INT NOT NULL,
    ratee_id INT NOT NULL,
    rating_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    rating INT CHECK (rating BETWEEN 1 AND 5),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_rating_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_rating_rater FOREIGN KEY (rater_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rating_ratee FOREIGN KEY (ratee_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- INDEXES
-- =========================
CREATE INDEX idx_user_username ON "User"(username);
CREATE INDEX idx_user_uuid ON "User"(user_uuid);
CREATE INDEX idx_auth_email ON Auth(email);
CREATE INDEX idx_auth_user_id ON Auth(user_id);
CREATE INDEX idx_ride_creator ON Ride(creator_id);
CREATE INDEX idx_ride_uuid ON Ride(ride_uuid);
CREATE INDEX idx_ride_start_time ON Ride(start_time);
CREATE INDEX idx_join_request_ride ON Join_Request(ride_id);
CREATE INDEX idx_join_request_partner ON Join_Request(partner_id);
CREATE INDEX idx_chat_ride ON Chat(ride_id);
CREATE INDEX idx_message_chat ON Message(chat_id);
CREATE INDEX idx_payment_ride ON Payment(ride_id);
CREATE INDEX idx_rating_ride ON Rating(ride_id);
