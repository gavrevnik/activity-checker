ALTER TABLE entities ADD COLUMN presentation TEXT NOT NULL DEFAULT '{}';

-- Direct canonical updates must also invalidate their derived display values.
CREATE TRIGGER entities_presentation_invalidate
AFTER UPDATE OF data,country,city ON entities
WHEN (NEW.data != OLD.data OR NEW.country != OLD.country OR NEW.city != OLD.city)
  AND NEW.presentation = OLD.presentation
BEGIN
  UPDATE entities SET presentation='{}' WHERE id=NEW.id;
END;
