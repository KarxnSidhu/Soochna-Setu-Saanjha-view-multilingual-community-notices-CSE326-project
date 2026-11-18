"""SQLite connections and the small, relational noticeboard schema."""
import sqlite3
from pathlib import Path
from flask import current_app, g


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    Path(current_app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    get_db().executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','reviewer'))
        );
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE,
            hi TEXT, pa TEXT, icon TEXT NOT NULL DEFAULT '▤'
        );
        CREATE TABLE IF NOT EXISTS notices (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
            action TEXT NOT NULL, issuer TEXT NOT NULL, location TEXT NOT NULL,
            category TEXT NOT NULL REFERENCES categories(id),
            original_language TEXT NOT NULL CHECK(original_language IN ('en','hi','pa')),
            published TEXT NOT NULL, expiry TEXT NOT NULL,
            urgent INTEGER NOT NULL DEFAULT 0, critical INTEGER NOT NULL DEFAULT 0,
            highlighted INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN ('draft','published','withdrawn','archived')),
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS translations (
            notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
            language TEXT NOT NULL CHECK(language IN ('en','hi','pa')),
            title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK(status IN ('pending','completed','unavailable')),
            version INTEGER NOT NULL, reviewer TEXT, reviewedAt TEXT,
            PRIMARY KEY(notice_id, language)
        );
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            actor TEXT NOT NULL, action TEXT NOT NULL, notice TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS notice_publication ON notices(status, published, expiry);
    """)
    categories = [
        ('utilities', 'Utilities', 'ज़रूरी सेवाएँ', 'ਜ਼ਰੂਰੀ ਸੇਵਾਵਾਂ', '♧'),
        ('health', 'Health & wellbeing', 'स्वास्थ्य', 'ਸਿਹਤ', '♡'),
        ('events', 'Community events', 'सामुदायिक कार्यक्रम', 'ਭਾਈਚਾਰਕ ਸਮਾਗਮ', '◷'),
        ('safety', 'Safety & alerts', 'सुरक्षा और अलर्ट', 'ਸੁਰੱਖਿਆ ਅਤੇ ਅਲਰਟ', '△'),
        ('services', 'Public services', 'सार्वजनिक सेवाएँ', 'ਜਨਤਕ ਸੇਵਾਵਾਂ', '▤'),
        ('education', 'Education', 'शिक्षा', 'ਸਿੱਖਿਆ', '▱'),
        ('government', 'Government notices', 'सरकारी सूचनाएँ', 'ਸਰਕਾਰੀ ਸੂਚਨਾਵਾਂ', '▤'),
        ('general', 'General information', 'सामान्य जानकारी', 'ਆਮ ਜਾਣਕਾਰੀ', '◎'),
    ]
    get_db().executemany('INSERT OR IGNORE INTO categories VALUES (?,?,?,?,?)', categories)
    get_db().commit()


def notice_records(staff=False):
    from app import today
    db = get_db()
    sql = 'SELECT * FROM notices'
    params = ()
    if not staff:
        sql += " WHERE status IN ('published','archived') AND published <= ?"
        params = (today(),)
    records = [dict(row) for row in db.execute(sql + ' ORDER BY published DESC', params)]
    for notice in records:
        notice['translations'] = {}
        for row in db.execute('SELECT * FROM translations WHERE notice_id=?', (notice['id'],)):
            translation = dict(row)
            language = translation.pop('language')
            translation.pop('notice_id')
            if not staff and translation['status'] != 'completed':
                translation.update(title='', body='', action='')
            notice['translations'][language] = translation
        for key in ('urgent', 'critical', 'highlighted'):
            notice[key] = bool(notice[key])
        notice['expired'] = notice['expiry'] < today() or notice['status'] == 'archived'
    return records
