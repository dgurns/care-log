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

4. Initialize the local database:

```bash
npm run db:push
```

5. Start the development server:

```bash
npm run dev
```

The application will be available at http://localhost:5173

## Cloud Version

A hosted version of Care Log is available, but access is currently limited to specific email addresses while I work on usage billing and a more secure data storage solution.
