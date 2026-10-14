-- Up Migration

-- Contact details, copied from Auth's UserRegistered / UserEmailVerified events (event-carried
-- state transfer): this service never reads the Auth database. The phone number is optional and
-- set by the customer in their preferences.
CREATE TABLE recipients (
  user_id         uuid PRIMARY KEY,
  email           varchar(320),
  full_name       varchar(200),
  email_verified  boolean NOT NULL DEFAULT false,
  phone           varchar(20),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE preferences (
  user_id              uuid PRIMARY KEY,
  email_order_updates  boolean NOT NULL DEFAULT true,
  email_marketing      boolean NOT NULL DEFAULT false,
  sms_order_updates    boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE notification_channel AS ENUM ('email', 'sms');

CREATE TYPE notification_status AS ENUM (
  'QUEUED',    -- waiting for (another) delivery attempt
  'SENDING',   -- leased by a worker
  'SENT',
  'FAILED',    -- gave up after the last attempt, or can never be delivered
  'SKIPPED'    -- opted out, or no address for the channel
);

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY,
  -- Business identity of the message: one notification per (dedupe key, channel), whatever the
  -- number of deliveries of the source message or command.
  dedupe_key           varchar(300) NOT NULL,
  channel              notification_channel NOT NULL,
  template_key         varchar(100) NOT NULL,
  -- A user (address resolved from the directory at send time), and/or a fixed address (admin
  -- alerts; transactional messages, where Auth supplies the current address).
  recipient_user_id    uuid,
  recipient_address    varchar(320),
  -- Template data. NEVER secrets: secret-bearing messages are rendered in memory and only their
  -- outcome is recorded here (data then holds non-secret fields only).
  data                 jsonb NOT NULL DEFAULT '{}',
  status               notification_status NOT NULL DEFAULT 'QUEUED',
  -- Secret-bearing (password reset, email verification): rendered and sent inside the request that
  -- carried the secret. The worker never touches these rows: it could not render them.
  in_memory_only       boolean NOT NULL DEFAULT false,
  skip_reason          varchar(50),
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  lease_until          timestamptz,
  last_error           varchar(500),
  provider_message_id  varchar(300),
  source_message_id    uuid,
  source_type          varchar(100),
  correlation_id       varchar(100),
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_dedupe UNIQUE (dedupe_key, channel),
  CONSTRAINT ck_notifications_recipient CHECK (recipient_user_id IS NOT NULL OR recipient_address IS NOT NULL)
);

-- The delivery worker's queue.
CREATE INDEX ix_notifications_due ON notifications (next_attempt_at) WHERE status IN ('QUEUED', 'SENDING') AND NOT in_memory_only;
CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX ix_notifications_status ON notifications (status, created_at DESC);

CREATE TABLE delivery_attempts (
  id               bigserial PRIMARY KEY,
  notification_id  uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  attempt          integer NOT NULL,
  outcome          varchar(20) NOT NULL CHECK (outcome IN ('SENT', 'FAILED', 'SKIPPED')),
  error            varchar(500),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_delivery_attempts_notification ON delivery_attempts (notification_id, attempt);

-- Inbox dedupe: a redelivered SQS message is a no-op.
CREATE TABLE processed_messages (
  message_id    uuid PRIMARY KEY,
  message_type  varchar(100) NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE processed_messages;
DROP TABLE delivery_attempts;
DROP TABLE notifications;
DROP TYPE notification_status;
DROP TYPE notification_channel;
DROP TABLE preferences;
DROP TABLE recipients;
