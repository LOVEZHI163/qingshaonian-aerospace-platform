CREATE TABLE IF NOT EXISTS site_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  platform_name TEXT NOT NULL,
  featured_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  platform_intro TEXT NOT NULL DEFAULT '',
  organizers JSONB NOT NULL DEFAULT '[]'::jsonb,
  contact TEXT NOT NULL DEFAULT '',
  icp TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL,
  seo_description TEXT NOT NULL DEFAULT '',
  default_hero_media_id TEXT,
  share_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_public_profiles (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  slogan TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  is_visible BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  hero_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('announcement','news','work','recap','guide')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','published','offline')),
  publish_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  cover_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('draft','public')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  variants JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS content_attachments (
  content_id TEXT NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_assets(id),
  label TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (content_id, media_id)
);

ALTER TABLE site_settings
  ADD CONSTRAINT site_settings_default_hero_media_id_fkey
  FOREIGN KEY (default_hero_media_id) REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE site_settings
  ADD CONSTRAINT site_settings_share_media_id_fkey
  FOREIGN KEY (share_media_id) REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE event_public_profiles
  ADD CONSTRAINT event_public_profiles_hero_media_id_fkey
  FOREIGN KEY (hero_media_id) REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE content_posts
  ADD CONSTRAINT content_posts_cover_media_id_fkey
  FOREIGN KEY (cover_media_id) REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS content_posts_status_publish_at_idx ON content_posts(status, publish_at);
CREATE INDEX IF NOT EXISTS content_posts_event_id_type_idx ON content_posts(event_id, type);
CREATE INDEX IF NOT EXISTS event_public_profiles_is_visible_display_order_idx ON event_public_profiles(is_visible, display_order);

INSERT INTO site_settings (id, platform_name, seo_title)
VALUES ('default', '温州市青少年航空航天创新比赛', '温州市青少年航空航天创新比赛')
ON CONFLICT (id) DO NOTHING;
