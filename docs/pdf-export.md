# PDF export

Download an exact revision with `GET /api/v1/documents/:documentId/revisions/:revisionNumber/pdf`. The route requires an active bearer session and both `documents.read` and `documents.export` for the document type. The stored lifecycle policy permits draft, finalized, and archived documents. The response is an `application/pdf` attachment with `Cache-Control: private, no-store`. A successful render records the actor, revision, and template version in the activity log.

## Rendering in deployment

Install the pinned Playwright Chromium binary with `pnpm exec playwright install chromium --only-shell`. Run the API as a non-root account on a host that supports the Chromium sandbox and the browser's system libraries. The API starts Chromium lazily on the first export, reuses the browser, and closes it when the server shuts down.

Export loads and verifies the revision's pinned published snapshot. Eta loads the saved root source and the reviewed RAAO partial in memory with automatic escaping. The data comes from the stored recursive schema and vetted assets. The compiler uses saved template markup to find Tailwind utilities, then adds the saved print stylesheet. Chromium applies the saved paper size, margins, orientation, and print flags. Paper sizes include A3, A4, A5, Letter, and Legal. The API uses the snapshot's settings for every request.

Each render uses a fresh offline context with page JavaScript and service workers disabled. Browser routing blocks requests, and a content security policy permits the inline styles and embedded image data. The readiness check waits for fonts and for image decoding. The format 1 snapshot uses pinned Eta and Tailwind versions. System fonts and Chromium affect layout, so keep the deployment runtime consistent when comparing reprints.

The renderer admits two concurrent exports per API process. Excess requests return `503` with `Retry-After`. The snapshot lookup and stylesheet compilation each have a five-second deadline. Browser launch has an eight-second deadline, and each print context has a 15-second deadline. It enforces the form's recursive input limits, a 1,000-row print limit, an 8 MiB HTML limit, and a 12 MiB PDF response limit. Oversized documents return `422` and timed-out renders return `504`. Contexts close on completion or failure.

## Tests

Run `RUN_PDF_TESTS=1 pnpm test` with Chromium and Poppler (`pdfinfo`, `pdftotext`, and `pdfimages`) available. Set `DEVICE_TEST_DATABASE_URL` to a migrated disposable PostgreSQL database to include the HTTP tests for authorization, historical snapshots, headers, and export audit events. The PDF fixtures cover three input scenarios for each of the six forms.
