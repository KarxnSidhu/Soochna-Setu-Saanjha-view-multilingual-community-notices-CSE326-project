"""Integration tests use temporary SQLite files, never project data."""
import tempfile
import unittest
from pathlib import Path
from datetime import date, timedelta
from werkzeug.security import generate_password_hash
from app import create_app, today
from database import get_db


class NoticeboardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = dict(TESTING=True, SECRET_KEY='test-only', DATABASE=str(Path(self.directory.name) / 'test.db'))
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        with self.app.app_context(), get_db() as db:
            for role in ('admin', 'reviewer'):
                db.execute('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)',
                           (role, generate_password_hash('test-password'), role))
        self.token = self.client.get('/api/session').json['csrf']
        self.login('admin')

    def tearDown(self):
        self.directory.cleanup()

    def send(self, method, path, body=None):
        return self.client.open('/api' + path, method=method, json=body, headers={'X-CSRF-Token': self.token})

    def login(self, role):
        result = self.send('POST', '/login', {'username': role, 'password': 'test-password'})
        self.assertEqual(result.status_code, 200)
        self.token = result.json['csrf']

    def values(self, **changes):
        value = dict(title='Water update', body='Pipeline maintenance', action='Store water',
                     issuer='Residents', location='Sector 12', category='utilities',
                     original_language='en', published=today(),
                     expiry=(date.fromisoformat(today()) + timedelta(days=2)).isoformat(),
                     urgent=True, critical=False, highlighted=True)
        return value | changes

    def create(self, **changes):
        result = self.send('POST', '/notices', self.values(**changes))
        self.assertEqual(result.status_code, 201, result.json)
        return result.json['id']

    def public(self, query=''):
        return self.client.get('/api/notices' + query).json['notices']

    def test_persistence_drafts_publishing_and_permissions(self):
        notice_id = self.create()
        self.assertEqual(self.public(), [])
        self.assertEqual(self.send('PATCH', f'/notices/{notice_id}/status', {'status':'archived'}).status_code, 400)
        self.assertEqual(self.send('PATCH', f'/notices/{notice_id}/status', {'status':'published'}).status_code, 200)
        self.assertTrue(self.public()[0]['highlighted'])
        other = create_app(self.config).test_client()
        self.assertEqual(other.get('/api/notices').json['notices'][0]['id'], notice_id)
        token = other.get('/api/session').json['csrf']
        self.assertEqual(other.post('/api/notices', json=self.values(), headers={'X-CSRF-Token':token}).status_code, 401)
        self.assertEqual(other.get('/api/workspace').status_code, 401)
        self.login('reviewer')
        self.assertEqual(self.send('DELETE', f'/notices/{notice_id}').status_code, 403)
        self.assertEqual(self.send('POST', '/notices', self.values()).status_code, 403)

    def test_translations_and_source_changes(self):
        notice_id = self.create(original_language='hi')
        self.send('PATCH', f'/notices/{notice_id}/status', {'status':'published'})
        path = f'/notices/{notice_id}/translations/en'
        translation = dict(title='Translated', body='Translated content', action='Read this',
                           status='pending', version=1, checked=True)
        self.assertEqual(self.send('PUT', path, translation).status_code, 200)
        self.assertEqual(self.public()[0]['translations']['en']['body'], '')
        self.login('reviewer')
        self.assertEqual(self.send('PUT', path, translation | {'status':'completed'}).status_code, 200)
        self.assertEqual(self.public()[0]['translations']['en']['title'], 'Translated')
        self.assertEqual(len(self.public('?language=en')), 1)
        self.login('admin')
        edited = self.values(original_language='hi', title='Changed', version=1)
        self.assertEqual(self.send('PUT', f'/notices/{notice_id}', edited).status_code, 200)
        self.assertEqual(self.public()[0]['translations']['en']['status'], 'pending')
        self.assertEqual(self.send('PUT', path, translation).status_code, 409)
        self.assertEqual(self.send('PUT', f'/notices/{notice_id}', edited).status_code, 409)
        self.assertEqual(self.send('PUT', path, translation | {'version':2,'status':'unavailable'}).status_code, 200)
        self.assertEqual(self.public()[0]['translations']['en']['status'], 'unavailable')

    def test_dates_search_filters_and_validation(self):
        active = self.create()
        self.send('PATCH', f'/notices/{active}/status', {'status':'published'})
        for query in ('?q=water','?q=utilities','?q=English','?q=Sector%2012',
                      '?category=utilities','?priority=urgent','?state=active','?language=en'):
            self.assertEqual(len(self.public(query)), 1, query)
        self.assertEqual(self.public('?q=missing'), [])
        self.assertEqual(self.public('?priority=normal'), [])
        yesterday = (date.fromisoformat(today()) - timedelta(days=1)).isoformat()
        self.send('PUT', f'/notices/{active}', self.values(published=yesterday, expiry=yesterday, version=1))
        self.assertEqual(self.public('?state=active'), [])
        self.assertTrue(self.public('?state=expired')[0]['expired'])
        self.assertEqual(self.send('PATCH', f'/notices/{active}/status', {'status':'published'}).status_code, 400)
        future = (date.fromisoformat(today()) + timedelta(days=1)).isoformat()
        scheduled = self.create(published=future)
        self.send('PATCH', f'/notices/{scheduled}/status', {'status':'published'})
        self.assertNotIn(scheduled, [n['id'] for n in self.public()])
        for changes in ({'title':' '},{'expiry':'2026-02-30'},{'category':'missing'},
                        {'original_language':'xx'},{'urgent':'true'},{'body':None}):
            self.assertEqual(self.send('POST', '/notices', self.values(**changes)).status_code, 400)
        self.assertEqual(self.client.post('/api/notices', json=self.values()).status_code, 403)

    def test_delete_categories_and_export_records(self):
        self.assertEqual(self.send('POST','/categories',{'name':'Transport'}).status_code, 201)
        self.assertEqual(self.send('POST','/categories',{'name':'transport'}).status_code, 409)
        notice_id = self.create()
        self.send('PUT',f'/notices/{notice_id}/translations/hi',{'status':'pending','version':1})
        self.assertEqual(self.send('DELETE',f'/notices/{notice_id}').status_code, 200)
        with self.app.app_context():
            self.assertEqual(get_db().execute('SELECT COUNT(*) FROM translations').fetchone()[0], 0)
        self.assertGreaterEqual(len(self.client.get('/api/workspace').json['logs']), 4)
        self.assertEqual(self.client.get('/database/notices.db').status_code, 404)


if __name__ == '__main__':
    unittest.main()
