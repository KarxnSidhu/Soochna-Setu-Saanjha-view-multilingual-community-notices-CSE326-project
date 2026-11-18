# Verification report

Verified on 18 November 2026 using Python 3.14, Flask 3.1.3 and headless Google Chrome.

## Passed

- Four backend integration tests containing assertions for creation, database persistence across separate app instances, publication, draft/scheduled privacy, publisher/reviewer permissions, CSRF, categories, searching/filtering, date validation, expiry, translation states, source-version conflicts and cascading deletion.
- Browser workflows: initial board, search, priority and expiry filtering, all-status and archive navigation, bookmarks, password sign-in/out, creation, preview preserving input, publication, completed Hindi translation, original-text disclosure and reload persistence.
- Extended browser workflows: editing the source language to Hindi, incomplete English translation saved as pending, unavailable translation status, custom category, JSON export contents, withdrawal and deletion.
- Browser rendering at widths 320, 390, 768 and 1440 pixels: no page-wide horizontal overflow. Desktop and mobile screenshots were visually inspected.
- No JavaScript page errors during the automated browser sequence. JavaScript syntax checks passed.

## Test isolation and limitations

Backend tests create temporary SQLite files. Browser tests also used an isolated database with the optional fictional examples and temporary test accounts. No test accounts or test records are included in the delivered application.

The Flask server started, but this execution environment blocked localhost connections. Browser fetch requests were therefore intercepted by a test-only bridge and fulfilled through Flask's real request handlers and SQLite database using Flask's test client. These were real backend operations, not hardcoded API responses. This verifies application integration, but does not verify a normal browser-to-server TCP connection or production hosting. The bridge is not part of the application.

No physical printer, multi-user load test, independent translation review, full screen-reader audit or accessibility certification was performed. Browser automation is not shipped as a dependency; the repeatable backend tests are included in test_app.py.
