# Admin UI Design

**Date:** 2025-11-17
**Status:** Approved for implementation

## Overview

Build a standalone React admin interface at `admin.divine.video` for managing usernames in the Divine Name Server. The UI will enable searching through millions of usernames and performing administrative actions (reserve, assign, revoke/burn).

## Requirements

### Functional Requirements
- Search usernames by partial match on name, pubkey, or email
- Paginated results (50 per page) for scalability
- Reserve usernames for brand protection
- Assign usernames directly to specific pubkeys
- Revoke usernames (recyclable or permanently burned)
- View list of protected reserved words

### Non-Functional Requirements
- Handle millions of username records efficiently
- Protected by Cloudflare Access authentication
- Responsive UI with Tailwind CSS
- Fast searches with indexed SQL queries

## Database Schema Changes

### Migration 0003: Add Email Field

```sql
-- Add email column to usernames table
ALTER TABLE usernames ADD COLUMN email TEXT;

-- Create index for email lookups
CREATE INDEX IF NOT EXISTS idx_usernames_email ON usernames(email);
```

**Field Properties:**
- `email`: TEXT, nullable (optional field)
- Indexed for faster LIKE queries
- No uniqueness constraint (same email can have multiple accounts)

## API Endpoints

### New Search Endpoint

**GET /api/admin/usernames/search**

Query Parameters:
- `q` (string, required): Search query for partial matching
- `status` (string, optional): Filter by status (active, reserved, revoked, burned)
- `page` (number, default: 1): Page number for pagination
- `limit` (number, default: 50, max: 100): Results per page

Response:
```json
{
  "ok": true,
  "results": [
    {
      "id": 1,
      "name": "alice",
      "pubkey": "3bf0c63...",
      "email": "alice@example.com",
      "status": "active",
      "created_at": 1700000000,
      "claimed_at": 1700000000
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1234,
    "total_pages": 25
  }
}
```

Search query implementation:
```sql
SELECT * FROM usernames
WHERE (name LIKE '%' || ? || '%'
       OR pubkey LIKE '%' || ? || '%'
       OR email LIKE '%' || ? || '%')
  AND (? IS NULL OR status = ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

### Existing Endpoints (No Changes)
- `POST /api/admin/username/reserve` - Reserve username
- `POST /api/admin/username/assign` - Assign to pubkey
- `POST /api/admin/username/revoke` - Revoke/burn username

## Frontend Architecture

### Technology Stack
- **Framework:** React 18 with TypeScript
- **Routing:** React Router v6
- **Styling:** Tailwind CSS
- **Build Tool:** Vite
- **HTTP Client:** Fetch API

### Directory Structure

```
admin-ui/
├── src/
│   ├── components/
│   │   ├── Layout.tsx           # Shared layout with nav
│   │   ├── SearchBar.tsx        # Search input component
│   │   ├── UsernameTable.tsx    # Paginated results table
│   │   ├── Pagination.tsx       # Pagination controls
│   │   └── StatusBadge.tsx      # Status visual indicator
│   ├── pages/
│   │   ├── Dashboard.tsx        # Search/browse usernames
│   │   ├── Reserve.tsx          # Reserve username form
│   │   ├── Assign.tsx           # Assign username form
│   │   ├── Revoke.tsx           # Revoke/burn form
│   │   └── ReservedWords.tsx    # View protected words
│   ├── api/
│   │   └── client.ts            # API client functions
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces
│   ├── App.tsx                  # Router setup
│   ├── main.tsx                 # Entry point
│   └── index.css                # Tailwind imports
├── public/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

### Routes

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | Dashboard | Search and browse usernames |
| `/reserve` | Reserve | Reserve username form |
| `/assign` | Assign | Assign username to pubkey |
| `/revoke` | Revoke | Revoke or burn username |
| `/reserved-words` | ReservedWords | View protected words |

### Key Components

**Dashboard/Search Page:**
- Search input with real-time query
- Status filter dropdown (all, active, reserved, revoked, burned)
- Results table showing: name, pubkey (truncated), email, status, created date
- Click row to see full details
- Action buttons per row: assign, revoke
- Pagination controls at bottom

**Form Pages:**
- Reserve: name + reason fields
- Assign: name + pubkey fields
- Revoke: name + burn checkbox
- All forms show success/error messages
- Redirect to dashboard on success

## Worker Integration

### Static File Serving

Update `src/index.ts` to serve React SPA:

```typescript
import { serveStatic } from 'hono/cloudflare-workers'

// Serve admin UI static files
app.use('/admin/*', serveStatic({ root: './admin-ui/dist' }))

// Fallback for SPA routing
app.get('/admin/*', serveStatic({ path: './admin-ui/dist/index.html' }))
```

### Build Process

1. Build React app: `cd admin-ui && npm run build`
2. Output goes to `admin-ui/dist/`
3. Worker deployment includes dist folder
4. Wrangler bundles everything together

### Routing Strategy

Cloudflare Worker Routes:
```
admin.divine.video/*               → divine-name-server worker
admin.divine.video/api/admin/*     → API endpoints (existing)
admin.divine.video/*               → React SPA files
```

Worker logic:
- API paths → route to admin endpoint handlers
- All other paths → serve React SPA static files
- React Router handles client-side routing

## Security

### Cloudflare Access Configuration

Protect all `admin.divine.video/*` routes:

1. **Zero Trust Dashboard → Access → Applications**
2. Create new application:
   - Name: "Divine Name Server Admin"
   - Subdomain: `admin`
   - Domain: `divine.video`
   - Path: `/*` (protect everything)
3. Add policy:
   - Name: "Admin Access"
   - Action: Allow
   - Include: Email addresses (Rabble's email)
4. Session duration: 24 hours

**Note:** Cloudflare Access works at edge, before worker executes. No code-level auth needed in worker.

## Performance Considerations

### Search Optimization
- SQL indexes on name, pubkey, email for LIKE queries
- Limit results to 50-100 per page
- Add query timeout if search takes >5 seconds
- Show "refine your search" message for slow queries

### Frontend Performance
- React.lazy() for route-based code splitting
- Debounce search input (300ms)
- Cache API responses briefly (30 seconds)
- Show loading states during API calls

## Deployment Steps

1. Create migration 0003 (add email field)
2. Apply migration: `wrangler d1 migrations apply divine-name-server-db --remote`
3. Build React app: `cd admin-ui && npm run build`
4. Deploy worker: `wrangler deploy` (includes bundled React app)
5. Configure Cloudflare Access for `admin.divine.video/*`
6. Configure Worker Routes in Cloudflare dashboard

## Testing Strategy

### Manual Testing
- Search for usernames by name, pubkey fragment, email
- Test pagination (navigate pages, edge cases like last page)
- Reserve username, verify it appears in search
- Assign username to pubkey, verify active status
- Revoke with burn=false, verify recyclable
- Revoke with burn=true, verify permanent

### Edge Cases
- Empty search results
- Search with special characters
- Very long pubkeys/emails
- Concurrent admin actions
- Network errors during API calls

## Future Enhancements

Not included in this version:
- Full-text search (FTS5) for better performance
- Bulk operations (reserve multiple names)
- Username history/audit log
- Email validation on claim endpoint
- Export search results to CSV
- Real-time updates via WebSocket
