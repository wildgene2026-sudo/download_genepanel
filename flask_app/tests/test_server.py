from __future__ import annotations

import unittest

from flask_app.server import app


class FlaskRouteTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_homepage_and_health(self):
        homepage = self.client.get("/")
        self.assertEqual(homepage.status_code, 200)
        self.assertIn(b"Reference Bridge", homepage.data)
        self.assertIn(b'data-job="complete"', homepage.data)
        self.assertIn("default-src 'self'", homepage.headers["Content-Security-Policy"])

        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json()["status"], "ok")

    def test_unknown_job_kind_fails_closed(self):
        response = self.client.post("/api/jobs", json={"kind": "unknown"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("uk, au, or complete", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
