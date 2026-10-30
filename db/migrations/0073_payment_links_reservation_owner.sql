-- A pay attempt owns its reservation (reservation_id). Once it starts
-- capturing (capture_started_at) the reservation can no longer be
-- re-claimed by timeout, so at most one buyer can ever capture a link.
ALTER TABLE payment_links
    ADD COLUMN reservation_id UUID,
    ADD COLUMN capture_started_at TIMESTAMPTZ;
