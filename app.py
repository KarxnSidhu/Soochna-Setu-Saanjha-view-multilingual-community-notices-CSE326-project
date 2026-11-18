"""Run with python app.py. Manage accounts with the Flask CLI (see README)."""
import json
import os
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from uuid import uuid4

import click
from flask import Flask, abort, jsonify, request, send_from_directory, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash
from database import close_db, get_db, init_db, notice_records

ROOT = Path(__file__).resolve().parent
LANGUAGES = {'en': 'English', 'hi': 'Hindi हिन्दी', 'pa': 'Punjabi ਪੰਜਾਬੀ'}


def today():
    return datetime.now(timezone(timedelta(hours=5, minutes=30))).date().isoformat()


def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(DATABASE=str(ROOT / 'database' / 'notices.db'),
                      SECRET_KEY=os.environ.get('SECRET_KEY') or secrets.token_hex(32),
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                      MAX_CONTENT_LENGTH=128 * 1024)
    if config:
        app.config.update(config)
    app.teardown_appcontext(close_db)
    with app.app_context():
        init_db()

    def user():
        return get_db().execute('SELECT id, username, role FROM users WHERE id=?',
                                (session.get('user_id'),)).fetchone()

    def access(*roles):
        def decorator(fn):
            @wraps(fn)
            def wrapped(*args, **kwargs):
                account = user()
                if account is None:
                    abort(401, 'Please sign in.')
                if account['role'] not in roles:
                    abort(403, 'Your role cannot perform this action.')
                return fn(*args, **kwargs)
            return wrapped
        return decorator

    @app.before_request
    def csrf():
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            token = session.get('csrf')
            if not token or not secrets.compare_digest(token, request.headers.get('X-CSRF-Token', '')):
                abort(403, 'Session expired. Refresh the page and try again.')

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(sqlite3.Error)
    def database_error(error):
        app.logger.exception('Database operation failed')
        return jsonify(error='Database operation failed. Please retry.'), 500

    def data():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            abort(400, 'Send a JSON object.')
        return value

    def text(value, key, maximum, required=True):
        item = value.get(key, '')
        if not isinstance(item, str) or len(item.strip()) > maximum or (required and not item.strip()):
            abort(400, f'{key}: enter {1 if required else 0}–{maximum} characters.')
        return item.strip()

    def record(notice_id):
        row = get_db().execute('SELECT * FROM notices WHERE id=?', (notice_id,)).fetchone()
        if row is None:
            abort(404, 'Notice not found.')
        return dict(row)

    def log(action, title='', note=''):
        get_db().execute('INSERT INTO activity(actor,action,notice,note) VALUES (?,?,?,?)',
                         (user()['username'], action, title, note))

    def notice_values(value):
        result = {key: text(value, key, maximum) for key, maximum in
                  [('title', 160), ('body', 12000), ('action', 2000), ('issuer', 100), ('location', 100)]}
        result['category'] = text(value, 'category', 100)
        if not get_db().execute('SELECT 1 FROM categories WHERE id=?', (result['category'],)).fetchone():
            abort(400, 'Choose an existing category.')
        result['original_language'] = value.get('original_language', 'en')
        if not isinstance(result['original_language'], str) or result['original_language'] not in LANGUAGES:
            abort(400, 'Choose a supported source language.')
        for key in ('published', 'expiry'):
            try:
                raw = value.get(key, '')
                result[key] = date.fromisoformat(raw).isoformat()
                if raw != result[key]:
                    raise ValueError()
            except (ValueError, TypeError):
                abort(400, f'{key}: use a valid YYYY-MM-DD date.')
        if result['expiry'] < result['published']:
            abort(400, 'Expiry cannot precede publication.')
        for key in ('urgent', 'critical', 'highlighted'):
            if type(value.get(key, False)) is not bool:
                abort(400, f'{key} must be true or false.')
            result[key] = int(value.get(key, False))
        return result

    @app.get('/')
    def index():
        return send_from_directory(ROOT, 'index.html')

    @app.get('/<filename>')
    def assets(filename):
        if filename not in ('style.css', 'app.js', 'translations.js'):
            abort(404)
        return send_from_directory(ROOT, filename)

    @app.get('/api/session')
    def get_session():
        session.setdefault('csrf', secrets.token_hex(32))
        account = user()
        return jsonify(csrf=session['csrf'], user=dict(account) if account else None, today=today())

    @app.post('/api/login')
    def login():
        value = data()
        username = text(value, 'username', 80)
        password = text(value, 'password', 200)
        account = get_db().execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if not account or not check_password_hash(account['password_hash'], password):
            abort(401, 'Incorrect username or password.')
        session.clear()
        session.update(user_id=account['id'], csrf=secrets.token_hex(32))
        return get_session()

    @app.post('/api/logout')
    def logout():
        session.clear()
        return get_session()

    @app.get('/api/notices')
    def notices():
        # Public responses never include drafts or unpublished translation content.
        rows = notice_records()
        for key in ('category', 'location', 'original_language'):
            if request.args.get(key):
                rows = [n for n in rows if n[key] == request.args[key]]
        state = request.args.get('state')
        if state in ('active', 'expired'):
            rows = [n for n in rows if n['expired'] == (state == 'expired')]
        priority = request.args.get('priority')
        if priority in ('urgent', 'critical', 'normal'):
            rows = [n for n in rows if ('urgent' if n['urgent'] else 'critical' if n['critical'] else 'normal') == priority]
        language = request.args.get('language')
        if language:
            rows = [n for n in rows if n['original_language'] == language or
                    n['translations'].get(language, {}).get('status') == 'completed']
        query = request.args.get('q', '').strip().casefold()
        if query:
            categories = {r['id']: r['name'] for r in get_db().execute('SELECT * FROM categories')}
            rows = [n for n in rows if query in (' '.join(str(n[k]) for k in
                    ('title', 'body', 'location', 'category', 'original_language')) + ' ' +
                    LANGUAGES[n['original_language']] + ' ' + categories[n['category']] + ' ' +
                    ' '.join(t['title'] + ' ' + t['body'] + ' ' + LANGUAGES[lang]
                             for lang, t in n['translations'].items() if t['status'] == 'completed')).casefold()]
        return jsonify(notices=rows)

    @app.get('/api/categories')
    def categories():
        return jsonify(categories=[dict(row) for row in get_db().execute('SELECT * FROM categories')])

    @app.get('/api/workspace')
    @access('admin', 'reviewer')
    def workspace():
        return jsonify(notices=notice_records(True), logs=[dict(row) for row in
                       get_db().execute('SELECT * FROM activity ORDER BY id DESC LIMIT 150')])

    @app.post('/api/notices')
    @access('admin')
    def create_notice():
        values = notice_values(data())
        notice_id = uuid4().hex
        columns = ','.join(values)
        with get_db() as db:
            db.execute(f"INSERT INTO notices(id,{columns},status) VALUES (?,{','.join('?' for _ in values)},'draft')",
                       (notice_id, *values.values()))
            log('Created draft', values['title'])
        return jsonify(id=notice_id), 201

    @app.put('/api/notices/<notice_id>')
    @access('admin')
    def edit_notice(notice_id):
        old = record(notice_id)
        value = data()
        if value.get('version') != old['version']:
            abort(409, 'This notice changed. Reopen the editor before saving.')
        values = notice_values(value)
        changed = any(old[k] != v for k, v in values.items())
        with get_db() as db:
            if changed:
                db.execute(f"UPDATE notices SET {','.join(k+'=?' for k in values)},version=version+1 WHERE id=?",
                           (*values.values(), notice_id))
                db.execute("UPDATE translations SET status='pending',reviewer=NULL,reviewedAt=NULL WHERE notice_id=?", (notice_id,))
                db.execute('DELETE FROM translations WHERE notice_id=? AND language=?', (notice_id, values['original_language']))
                log('Updated notice; translations need review', values['title'])
        return jsonify(ok=True)

    @app.patch('/api/notices/<notice_id>/status')
    @access('admin')
    def status(notice_id):
        notice = record(notice_id)
        status = data().get('status')
        if status not in ('draft', 'published', 'withdrawn', 'archived'):
            abort(400, 'Invalid publication status.')
        if status == 'published' and notice['expiry'] < today():
            abort(400, 'Update the expiry date before publishing.')
        if status == 'archived' and notice['status'] not in ('published', 'archived'):
            abort(400, 'Only published notices can enter the public archive.')
        with get_db() as db:
            db.execute('UPDATE notices SET status=? WHERE id=?', (status, notice_id))
            log('Set status: ' + status, notice['title'])
        return jsonify(ok=True)

    @app.delete('/api/notices/<notice_id>')
    @access('admin')
    def delete(notice_id):
        notice = record(notice_id)
        with get_db() as db:
            db.execute('DELETE FROM notices WHERE id=?', (notice_id,))
            log('Deleted notice', notice['title'])
        return jsonify(ok=True)

    @app.put('/api/notices/<notice_id>/translations/<language>')
    @access('admin', 'reviewer')
    def translation(notice_id, language):
        notice = record(notice_id)
        value = data()
        if language not in LANGUAGES or language == notice['original_language']:
            abort(400, 'Choose a language other than the original.')
        if value.get('version') != notice['version']:
            abort(409, 'The source changed. Reopen the translation editor.')
        status = value.get('status')
        if status not in ('pending', 'completed', 'unavailable'):
            abort(400, 'Invalid translation status.')
        fields = [text(value, key, limit, status == 'completed') for key, limit in
                  [('title', 200), ('body', 16000), ('action', 3000)]]
        if status == 'completed' and value.get('checked') is not True:
            abort(400, 'Review the translation against the source before completing it.')
        with get_db() as db:
            db.execute('INSERT OR REPLACE INTO translations VALUES (?,?,?,?,?,?,?,?,?)',
                       (notice_id, language, *fields, status, notice['version'],
                        user()['username'] if status == 'completed' else None,
                        datetime.now(timezone.utc).isoformat() if status == 'completed' else None))
            log('Translation ' + status, notice['title'], language)
        return jsonify(ok=True)

    @app.post('/api/categories')
    @access('admin')
    def add_category():
        name = text(data(), 'name', 40)
        if get_db().execute('SELECT 1 FROM categories WHERE name=?', (name,)).fetchone():
            abort(409, 'That category already exists.')
        with get_db() as db:
            db.execute('INSERT INTO categories(id,name) VALUES (?,?)', (uuid4().hex, name))
            log('Added category', note=name)
        return jsonify(ok=True), 201

    @app.cli.command('create-user')
    @click.argument('username')
    @click.option('--role', type=click.Choice(['admin', 'reviewer']), default='admin')
    @click.password_option()
    def create_user(username, role, password):
        if len(password) < 10 or not 1 <= len(username) <= 80:
            raise click.ClickException('Use a username up to 80 characters and a password of at least 10 characters.')
        try:
            with get_db() as db:
                db.execute('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)',
                           (username, generate_password_hash(password), role))
        except sqlite3.IntegrityError:
            raise click.ClickException('Username already exists.')
        click.echo('Account created.')

    @app.cli.command('seed-demo')
    def seed_demo():
        if get_db().execute('SELECT 1 FROM notices LIMIT 1').fetchone():
            raise click.ClickException('Seed only an empty noticeboard to avoid overwriting work.')
        samples = json.loads((ROOT / 'sample_data.json').read_text(encoding='utf-8'))
        with get_db() as db:
            for notice in samples:
                for key in ('published', 'expiry'):
                    notice[key] = (date.fromisoformat(today()) + timedelta(days=notice[key])).isoformat()
                values = notice_values(notice)
                db.execute(f"INSERT INTO notices(id,{','.join(values)},status) VALUES (?,{','.join('?' for _ in values)},?)",
                           (notice['id'], *values.values(), notice['status']))
                for lang, item in notice['translations'].items():
                    db.execute('INSERT INTO translations(notice_id,language,title,body,action,status,version) VALUES (?,?,?,?,?,?,1)',
                               (notice['id'], lang, item['title'], item['body'], item['action'], 'pending'))
        click.echo('Original fictional samples added to SQLite. All translations remain pending.')

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=5000)
