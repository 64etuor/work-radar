-- Multi-select Life Wheel tags for braindump cards.
-- `area` remains the primary tag for existing code and backward compatibility.
ALTER TABLE signals ADD COLUMN area_tags TEXT;
