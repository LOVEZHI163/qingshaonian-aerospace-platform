ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS certificates_slot_check;

ALTER TABLE certificates
  ADD CONSTRAINT certificates_slot_check CHECK (slot IN (1, 2));
