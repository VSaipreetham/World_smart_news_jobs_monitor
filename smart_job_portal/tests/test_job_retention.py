"""Offline regression tests; no application imports or credentials required."""

import datetime
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from job_retention import build_prune_statement, retention_cutoff


class JobRetentionTests(unittest.TestCase):
    def test_legacy_database_keeps_application_history_and_notification_logs(self):
        with sqlite3.connect(':memory:') as database:
            database.execute('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT, notes TEXT, posted_date TEXT)')
            database.execute('CREATE TABLE daily_logs (date TEXT, count INTEGER)')
            database.execute("INSERT INTO daily_logs VALUES ('2026-09-23', 2)")
            rows = [
                (1, 'NEW', None, '2026-01-01 12:00:00'),
                (2, 'NEW', 'Recruiter contacted me', '2026-01-01 12:00:00'),
                (3, 'APPLIED', None, '2026-01-01 12:00:00'),
                (4, 'INTERVIEW', None, '2026-01-01 12:00:00'),
                (5, 'OFFER', None, '2026-01-01 12:00:00'),
                (6, 'REJECTED', None, '2026-01-01 12:00:00'),
                (7, 'ARCHIVED', None, '2026-01-01 12:00:00'),
                (8, 'QUEUED', None, '2026-01-01 12:00:00'),
                (9, 'NOTIFIED', None, '2026-01-01 12:00:00'),
                (10, 'NEW', None, '2026-09-23 12:00:00'),
                (11, 'NEW', None, None),
                (12, None, None, '2026-01-01 12:00:00'),
                (13, 'NEW', None, '2026-08-24 00:00:00'),
                (14, 'NEW', None, '2020-99-99'),
            ]
            database.executemany('INSERT INTO jobs VALUES (?, ?, ?, ?)', rows)
            statement = build_prune_statement(['id', 'status', 'notes', 'posted_date'])
            database.execute(statement, {'cutoff': '2026-08-24'})
            self.assertEqual([row[0] for row in database.execute('SELECT id FROM jobs ORDER BY id')], list(range(2, 15)))
            self.assertEqual(database.execute('SELECT count FROM daily_logs').fetchone()[0], 2)

    def test_node_columns_preserve_reminders_and_recently_seen_listings(self):
        columns = ['id', 'status', 'notes', 'posted_date', 'last_seen_at', 'applied_at', 'follow_up_at', 'archived_at']
        with sqlite3.connect(':memory:') as database:
            database.execute('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT, notes TEXT, posted_date TEXT, last_seen_at TEXT, applied_at TEXT, follow_up_at TEXT, archived_at TEXT)')
            rows = [
                (1, 'open', None, '2026-01-01T12:00:00Z', None, None, None, None),
                (2, 'open', None, '2026-01-01T12:00:00Z', '2026-09-23T12:00:00Z', None, None, None),
                (3, 'open', None, '2026-01-01T12:00:00Z', None, '2026-01-02', None, None),
                (4, 'open', None, '2026-01-01T12:00:00Z', None, None, '2026-09-24', None),
                (5, 'open', None, '2026-01-01T12:00:00Z', None, None, None, '2026-01-02'),
                (6, 'applied', None, '2026-01-01T12:00:00Z', None, None, None, None),
            ]
            database.executemany('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rows)
            database.execute(build_prune_statement(columns), {'cutoff': '2026-08-24'})
            self.assertEqual([row[0] for row in database.execute('SELECT id FROM jobs ORDER BY id')], [2, 3, 4, 5, 6])

    def test_incomplete_schema_and_bad_retention_are_safe(self):
        self.assertIsNone(build_prune_statement(['id', 'status', 'posted_date']))
        self.assertIsNone(build_prune_statement(['id', 'status', 'notes']))
        with self.assertRaises(ValueError):
            retention_cutoff(0)
        now = datetime.datetime(2026, 9, 23, 23, 30, tzinfo=datetime.timezone.utc)
        self.assertEqual(retention_cutoff(30, now), '2026-08-24')


if __name__ == '__main__':
    unittest.main()
