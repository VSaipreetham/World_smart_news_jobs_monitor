"""Offline approval/calendar regressions; all transports and configuration are mocked."""

import datetime
from email import message_from_string
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


def load_module(filename):
    spec = importlib.util.spec_from_file_location('test_' + filename, Path(__file__).resolve().parents[1] / f'{filename}.py')
    module = importlib.util.module_from_spec(spec)
    dotenv = types.ModuleType('dotenv')
    dotenv.load_dotenv = lambda: None
    with patch.dict(sys.modules, {'dotenv': dotenv}), patch.dict(os.environ, {
        'GMAIL_USER': 'reviewer@example.test',
        'GMAIL_APP_PASSWORD': 'test-only-not-a-real-password',
    }, clear=True):
        spec.loader.exec_module(module)
    return module


class NotificationApprovalTests(unittest.TestCase):
    def test_no_smtp_connection_without_explicit_approval(self):
        module = load_module('notifications')
        with patch.object(module.smtplib, 'SMTP') as smtp:
            self.assertFalse(module.send_email_notification('Engineer', 'Example', 'https://example.test/job'))
            self.assertFalse(module.send_email_notification('Engineer', 'Example', 'https://example.test/job', approved='yes'))
            smtp.assert_not_called()

    def test_approved_send_matches_displayed_plain_text_preview(self):
        module = load_module('notifications')
        preview = module.build_email_preview('Engineer', 'Example', 'https://example.test/job')
        with patch.object(module.smtplib, 'SMTP') as smtp:
            server = smtp.return_value.__enter__.return_value
            self.assertTrue(module.send_email_notification('Engineer', 'Example', 'https://example.test/job', approved=True))
            server.sendmail.assert_called_once()
            sender, recipient, raw_message = server.sendmail.call_args.args
            message = message_from_string(raw_message)
            self.assertEqual(sender, preview['to'])
            self.assertEqual(recipient, preview['to'])
            self.assertEqual(message['Subject'], preview['subject'])
            self.assertEqual(message.get_content_type(), 'text/plain')
            self.assertEqual(message.get_payload(decode=True).decode('utf-8'), preview['body'])

    def test_connection_cleanup_failure_does_not_report_accepted_mail_as_failed(self):
        module = load_module('notifications')
        with patch.object(module.smtplib, 'SMTP') as smtp:
            smtp.return_value.__exit__.side_effect = OSError('connection closed after acceptance')
            self.assertTrue(module.send_email_notification('Engineer', 'Example', 'https://example.test/job', approved=True))
            smtp.return_value.__enter__.return_value.sendmail.assert_called_once()

    def test_calendar_requires_approval_and_uses_exclusive_next_day_end(self):
        module = load_module('calendar_integration')
        service = MagicMock()
        with patch.object(module, 'get_calendar_service', return_value=service) as get_service:
            self.assertFalse(module.create_calendar_note('Engineer', 'https://example.test/job'))
            get_service.assert_not_called()
            self.assertTrue(module.create_calendar_note('Engineer', 'https://example.test/job', approved=True, day=datetime.date(2026, 12, 31)))
            event = service.events.return_value.insert.call_args.kwargs['body']
            self.assertEqual(event['start']['date'], '2026-12-31')
            self.assertEqual(event['end']['date'], '2027-01-01')


if __name__ == '__main__':
    unittest.main()
