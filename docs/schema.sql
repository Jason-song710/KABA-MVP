CREATE TABLE notices (
  id SERIAL PRIMARY KEY,
  notice_no VARCHAR(120),
  title VARCHAR(500) NOT NULL,
  ordering_agency VARCHAR(300),
  posted_at TIMESTAMP,
  deadline_at TIMESTAMP,
  budget_amount NUMERIC(18, 2),
  notice_url TEXT,
  detail_content TEXT,
  attachment_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  source VARCHAR(60) NOT NULL DEFAULT 'csv',
  source_raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT uq_notices_notice_no UNIQUE (notice_no),
  CONSTRAINT uq_notices_title_agency_posted UNIQUE (title, ordering_agency, posted_at)
);

CREATE INDEX ix_notices_title ON notices (title);
CREATE INDEX ix_notices_ordering_agency ON notices (ordering_agency);
CREATE INDEX ix_notices_posted_at ON notices (posted_at);
CREATE INDEX ix_notices_deadline_at ON notices (deadline_at);

CREATE TABLE notice_classifications (
  id SERIAL PRIMARY KEY,
  notice_id INTEGER NOT NULL UNIQUE REFERENCES notices(id) ON DELETE CASCADE,
  primary_score INTEGER NOT NULL DEFAULT 0,
  primary_category VARCHAR(80) NOT NULL,
  matched_keywords JSONB NOT NULL DEFAULT '{}'::jsonb,
  excluded_keyword_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_category VARCHAR(80) NOT NULL,
  ai_relevance_score INTEGER,
  matched_industries JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_member_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_reason TEXT,
  ai_summary TEXT,
  ai_status VARCHAR(40) NOT NULL DEFAULT 'not_requested',
  is_manual BOOLEAN NOT NULL DEFAULT false,
  manual_category VARCHAR(80),
  manual_reason TEXT,
  manual_updated_at TIMESTAMP,
  classified_at TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE keyword_dictionary (
  id SERIAL PRIMARY KEY,
  keyword VARCHAR(120) NOT NULL,
  grade VARCHAR(1) NOT NULL,
  score INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT uq_keyword_dictionary_keyword_grade UNIQUE (keyword, grade)
);

CREATE INDEX ix_keyword_dictionary_keyword ON keyword_dictionary (keyword);
CREATE INDEX ix_keyword_dictionary_grade ON keyword_dictionary (grade);

CREATE TABLE excluded_keywords (
  id SERIAL PRIMARY KEY,
  keyword VARCHAR(120) NOT NULL UNIQUE,
  is_strong BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX ix_excluded_keywords_keyword ON excluded_keywords (keyword);

CREATE TABLE ai_classification_logs (
  id SERIAL PRIMARY KEY,
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  model VARCHAR(120),
  request_prompt TEXT NOT NULL,
  response_text TEXT,
  parsed_json JSONB,
  success BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX ix_ai_classification_logs_notice_id ON ai_classification_logs (notice_id);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  hashed_password VARCHAR(255),
  role VARCHAR(40) NOT NULL DEFAULT 'viewer',
  company_name VARCHAR(255),
  contact_name VARCHAR(120),
  phone VARCHAR(80),
  member_type VARCHAR(120),
  preferred_industries JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  approval_notes TEXT,
  approved_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX ix_users_email ON users (email);
CREATE INDEX ix_users_approval_status ON users (approval_status);

CREATE TABLE collection_logs (
  id SERIAL PRIMARY KEY,
  source VARCHAR(60) NOT NULL,
  operation VARCHAR(120),
  status VARCHAR(40) NOT NULL,
  message TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  raw_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX ix_collection_logs_source ON collection_logs (source);
CREATE INDEX ix_collection_logs_status ON collection_logs (status);
