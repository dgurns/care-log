# Care Log

A private medical advisor powered by AI. Track your health concerns, get informed second opinions, and maintain a personal medical journal.

## Prerequisites

- Node.js 24+
- npm

## Local Development Setup

1. Copy the environment file and configure your settings:

```bash
cp .env.sample .env
```

2. Edit `.env` and set your values:
   - `ANTHROPIC_API_KEY` - Your Anthropic API key
   - `BETTER_AUTH_SECRET` - A random secret string for authentication
   - `ALLOWED_EMAILS` - Comma-separated list of emails allowed to access the app

3. Install dependencies:

```bash
npm install
```

4. Initialize the local database (only for a brand-new, empty database):

```bash
npm run db:push
```

5. Start the development server:

```bash
npm run dev
```

The application will be available at http://localhost:5173

## Schema Changes

Schema migrations run automatically on startup, both locally and in production, via `runStartupMigrations` in `app/db/index.ts`. To change the schema:

1. Edit `app/db/schema.ts`.
2. Add a matching idempotent block to the end of `runStartupMigrations`.
3. Restart the dev server to apply it locally. `make deploy` applies it in production.

Do not run `npm run db:push` against an existing database. The current drizzle-kit version rebuilds every table on each push and can fail partway through, leaving the database half-migrated. See the comment above `runStartupMigrations` for the full rules. Back up production with `make pull-prod-db-to-local` before deploying a schema change.

## Cloud Version

A hosted version of Care Log is available, but access is currently limited to specific email addresses until I figure out usage billing and a more secure data storage solution.
