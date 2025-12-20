# Remove 2-Character Minimum Search Requirement

## Summary

This PR removes the 2-character minimum requirement for searching reserved usernames, allowing administrators to run blank searches to view all reserved names. This improves the admin UX by enabling quick browsing of all reserved usernames without needing to enter a search term.

## Problem

Previously, the admin dashboard required at least 2 characters to perform a search, making it impossible to:
- View all reserved names at once
- Browse through reserved usernames without knowing what to search for
- Use status filters effectively without a search query

## Changes Made

### Frontend (`admin-ui/src/pages/Dashboard.tsx`)
- Removed `query.length >= 2` check that prevented searches
- Removed "Enter at least 2 characters to search" message
- Search now executes immediately, even with empty query
- Results table displays for all searches, including empty queries

### Backend (`src/routes/admin.ts`)
- Updated validation to allow empty strings (still requires `q` parameter to be present)
- Updated error message from "between 1 and 100 characters" to "100 characters or less"
- Empty query string (`q=`) now returns all results

### Database Query (`src/db/queries.ts`)
- Modified `searchUsernames` to handle empty queries gracefully
- When query is empty, skips LIKE filtering and returns all records
- Uses `WHERE 1=1` when no filters are applied (empty query + no status filter)
- Properly handles status filtering with empty queries

## Testing

### Updated Tests (`src/routes/admin.test.ts`)
- Changed test from expecting 400 error for empty query to expecting 200 success
- Added test: `should allow empty query string to return all results`
- Added test: `should allow empty query with status filter`
- Added test: `should handle single character query (no minimum requirement)`
- Added test: `should return successful search with valid query`

### Updated Tests (`src/db/queries.test.ts`)
- Fixed mock database to correctly handle empty queries (no LIKE clause)
- Added comprehensive test: `should handle empty query string and return all results`
- Added test: `should handle empty query with status filter`
- Added test: `should handle empty query with reserved status filter`
- Added test: `should handle empty query with pagination`
- Added test: `should handle empty query with pagination page 2`

### Test Results
- All 16 database query tests passing
- Empty query functionality verified
- Status filtering with empty queries verified
- Pagination with empty queries verified

## Behavior Changes

### Before
- Empty search: Shows "Enter at least 2 characters to search"
- Single character search: Shows "Enter at least 2 characters to search"
- 2+ character search: Returns filtered results

### After
- Empty search: Returns all results (optionally filtered by status)
- Single character search: Returns filtered results
- 2+ character search: Returns filtered results (unchanged)

## Use Cases Enabled

1. **View All Reserved Names**: Run a blank search with status filter set to "Reserved" to see all reserved usernames
2. **Browse All Active Names**: Run a blank search with status filter set to "Active" to see all active usernames
3. **Quick Overview**: Run a blank search with no status filter to see all usernames across all statuses
4. **Single Character Searches**: Can now search with just 1 character (e.g., search for "a" to find all names starting with "a")

## Backward Compatibility

**Fully backward compatible** - All existing search functionality continues to work exactly as before. The only change is that searches with fewer than 2 characters now work instead of being blocked.

## Files Changed

- `admin-ui/src/pages/Dashboard.tsx` - Removed 2-character minimum check
- `src/routes/admin.ts` - Allow empty query strings
- `src/db/queries.ts` - Handle empty queries in SQL generation
- `src/routes/admin.test.ts` - Updated and added tests for empty queries
- `src/db/queries.test.ts` - Updated mock and added comprehensive empty query tests

## Checklist

- [x] Code changes implemented
- [x] Tests updated and passing
- [x] Backward compatibility maintained
- [x] No breaking changes
- [x] Documentation updated (this PR description)

## Related Issues

Fixes the requirement that prevented blank searches to view all reserved names.

