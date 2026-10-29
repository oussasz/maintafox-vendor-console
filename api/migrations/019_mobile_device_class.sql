-- Mobile device class (Android field app on personal phones).
--
-- Every activation has a class: 'desktop' (the Windows app, counted against max_machines) or
-- 'mobile' (the field app, counted against max_mobile_devices). A fingerprint keeps the class it was
-- activated with; activation refuses the other class (routes/activation.ts).
--
-- Existing rows: every activation is a desktop and every licence has 0 mobile devices, which means
-- mobile is not licensed until a vendor operator sets a count (routes/licences.ts). How many phones
-- a licence includes is a commercial decision, so the schema does not grant any.

ALTER TABLE machine_activations
  ADD COLUMN device_class TEXT NOT NULL DEFAULT 'desktop'
  CONSTRAINT machine_activations_device_class_check CHECK (device_class IN ('desktop', 'mobile'));

ALTER TABLE license_keys
  ADD COLUMN max_mobile_devices INTEGER NOT NULL DEFAULT 0
  CONSTRAINT license_keys_max_mobile_devices_check CHECK (max_mobile_devices BETWEEN 0 AND 1000);

-- Slot counting reads active activations of one class on one licence.
CREATE INDEX machine_activations_license_class_idx
  ON machine_activations (license_id, device_class) WHERE revoked_at IS NULL;
