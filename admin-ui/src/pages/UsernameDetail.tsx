// ABOUTME: Username detail page for viewing and managing individual usernames
// ABOUTME: Shows all metadata and provides actions like assign, revoke, burn
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getUsernameDetail, updateUsernameMetadata, assignUsername, revokeUsername } from '../api/client'
import type { Username } from '../types'
import StatusBadge from '../components/StatusBadge'

export default function UsernameDetail() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [username, setUsername] = useState<Username | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Action states
  const [showAssign, setShowAssign] = useState(false)
  const [assignPubkey, setAssignPubkey] = useState('')
  const [assignLoading, setAssignLoading] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)

  const [showRevoke, setShowRevoke] = useState(false)
  const [burnOnRevoke, setBurnOnRevoke] = useState(false)
  const [revokeLoading, setRevokeLoading] = useState(false)
  const [draftNotes, setDraftNotes] = useState('')
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  useEffect(() => {
    loadUsername()
  }, [name])

  const loadUsername = async () => {
    if (!name) return
    setLoading(true)
    setError(null)

    try {
      const result = await getUsernameDetail(name)
      setUsername(result.username)
      setDraftNotes(result.username.admin_notes || '')
      setDraftTags(result.username.tags || [])
      setSaveError(null)
      setSaveSuccess(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load username')
    } finally {
      setLoading(false)
    }
  }

  const handleAddTag = () => {
    const nextTag = tagInput.trim().replace(/\s+/g, ' ')
    if (!nextTag) return

    setDraftTags((currentTags) => {
      const exists = currentTags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())
      return exists ? currentTags : [...currentTags, nextTag]
    })
    setTagInput('')
    setSaveSuccess(null)
  }

  const handleRemoveTag = (tagToRemove: string) => {
    setDraftTags((currentTags) => currentTags.filter((tag) => tag !== tagToRemove))
    setSaveSuccess(null)
  }

  const handleSaveMetadata = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!username) return

    setSaveLoading(true)
    setSaveError(null)
    setSaveSuccess(null)

    try {
      const result = await updateUsernameMetadata(
        username.name,
        draftNotes.trim() ? draftNotes.trim() : null,
        draftTags
      )
      setUsername(result.username)
      setDraftNotes(result.username.admin_notes || '')
      setDraftTags(result.username.tags || [])
      setSaveSuccess('Internal tracking updated.')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaveLoading(false)
    }
  }

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name) return

    setAssignLoading(true)
    setAssignError(null)

    try {
      const result = await assignUsername(name, assignPubkey)
      if (result.ok) {
        setShowAssign(false)
        setAssignPubkey('')
        await loadUsername()
      } else {
        setAssignError(result.error || 'Failed to assign')
      }
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setAssignLoading(false)
    }
  }

  const handleRevoke = async () => {
    if (!name) return

    setRevokeLoading(true)

    try {
      const result = await revokeUsername(name, burnOnRevoke)
      if (result.ok) {
        setShowRevoke(false)
        await loadUsername()
      }
    } catch (err) {
      console.error('Revoke failed:', err)
    } finally {
      setRevokeLoading(false)
    }
  }

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    return new Date(timestamp * 1000).toLocaleString()
  }

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  if (error || !username) {
    return (
      <div className="max-w-2xl">
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error || 'Username not found'}</p>
        </div>
        <button
          onClick={() => navigate('/')}
          className="mt-4 text-blue-600 hover:text-blue-800"
        >
          ← Back to search
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <button
          onClick={() => navigate('/')}
          className="text-blue-600 hover:text-blue-800 text-sm mb-2"
        >
          ← Back to search
        </button>
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold text-gray-900">{username.name}</h2>
          <StatusBadge status={username.status} />
        </div>
        <p className="mt-1 text-sm text-gray-600">
          {username.name}@divine.video
        </p>
        {draftTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {draftTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Internal Tracking</h3>
        </div>
        <form onSubmit={handleSaveMetadata} className="px-6 py-4 space-y-5">
          <div>
            <label htmlFor="admin-notes" className="block text-sm font-medium text-gray-700">
              Internal Notes
            </label>
            <textarea
              id="admin-notes"
              rows={5}
              value={draftNotes}
              onChange={(event) => {
                setDraftNotes(event.target.value)
                setSaveSuccess(null)
              }}
              placeholder="Add context for trust and safety, support, marketing, or outreach."
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="tag-input" className="block text-sm font-medium text-gray-700">
              Tags
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="tag-input"
                type="text"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleAddTag()
                  }
                }}
                placeholder="VIP, brand, creator, outreach..."
                className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Add Tag
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {draftTags.length > 0 ? (
                draftTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                  >
                    {tag}
                    <span className="ml-2 text-blue-500">×</span>
                  </button>
                ))
              ) : (
                <p className="text-sm text-gray-500">No internal tags yet.</p>
              )}
            </div>
          </div>

          {saveError && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{saveError}</div>
          )}
          {saveSuccess && (
            <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">{saveSuccess}</div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saveLoading}
              className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saveLoading ? 'Saving...' : 'Save Internal Tracking'}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden mb-6">
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Details</h3>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-gray-500">Status</p>
              <p className="mt-1"><StatusBadge status={username.status} /></p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Recyclable</p>
              <p className="mt-1 text-sm text-gray-900">
                {username.recyclable ? 'Yes' : 'No'}
              </p>
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-gray-500">Pubkey</p>
            <p className="mt-1 text-sm font-mono text-gray-900 break-all">
              {username.pubkey || '-'}
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-gray-500">Relays</p>
            <p className="mt-1 text-sm font-mono text-gray-900 break-all">
              {username.relays || '-'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-gray-500">Created</p>
              <p className="mt-1 text-sm text-gray-900">{formatDate(username.created_at)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Claimed</p>
              <p className="mt-1 text-sm text-gray-900">{formatDate(username.claimed_at)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-gray-500">Updated</p>
              <p className="mt-1 text-sm text-gray-900">{formatDate(username.updated_at)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Revoked</p>
              <p className="mt-1 text-sm text-gray-900">{formatDate(username.revoked_at)}</p>
            </div>
          </div>

          {username.reserved_reason && (
            <div>
              <p className="text-sm font-medium text-gray-500">Reserved Reason</p>
              <p className="mt-1 text-sm text-gray-900">{username.reserved_reason}</p>
            </div>
          )}

          <div>
            <p className="text-sm font-medium text-gray-500">Source</p>
            <p className="mt-1 text-sm text-gray-900">{username.claim_source}</p>
          </div>

          {username.created_by && (
            <div>
              <p className="text-sm font-medium text-gray-500">Created by</p>
              <p className="mt-1 text-sm text-gray-900">{username.created_by}</p>
            </div>
          )}
        </div>
      </div>

      {/* Actions Card */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Actions</h3>
        </div>
        <div className="px-6 py-4 space-y-4">
          {/* Assign Action */}
          {(username.status === 'reserved' || username.status === 'revoked') && (
            <div>
              {!showAssign ? (
                <button
                  onClick={() => setShowAssign(true)}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
                >
                  Assign to Pubkey
                </button>
              ) : (
                <form onSubmit={handleAssign} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Pubkey (hex or npub)
                    </label>
                    <input
                      type="text"
                      value={assignPubkey}
                      onChange={(e) => setAssignPubkey(e.target.value)}
                      required
                      placeholder="npub1... or 64-character hex"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border font-mono text-xs"
                    />
                  </div>
                  {assignError && (
                    <p className="text-sm text-red-600">{assignError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={assignLoading}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                    >
                      {assignLoading ? 'Assigning...' : 'Assign'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAssign(false)
                        setAssignPubkey('')
                        setAssignError(null)
                      }}
                      className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Revoke Action */}
          {(username.status === 'active' || username.status === 'reserved') && (
            <div>
              {!showRevoke ? (
                <button
                  onClick={() => setShowRevoke(true)}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700"
                >
                  Revoke Username
                </button>
              ) : (
                <div className="space-y-3 p-4 bg-red-50 rounded-lg">
                  <p className="text-sm text-red-800">
                    Are you sure you want to revoke "{username.name}"?
                  </p>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="burn"
                      checked={burnOnRevoke}
                      onChange={(e) => setBurnOnRevoke(e.target.checked)}
                      className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                    />
                    <label htmlFor="burn" className="ml-2 text-sm text-red-800">
                      Burn (permanently prevent reuse)
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleRevoke}
                      disabled={revokeLoading}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                    >
                      {revokeLoading ? 'Revoking...' : (burnOnRevoke ? 'Burn' : 'Revoke')}
                    </button>
                    <button
                      onClick={() => {
                        setShowRevoke(false)
                        setBurnOnRevoke(false)
                      }}
                      className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {username.status === 'burned' && (
            <p className="text-sm text-gray-500 italic">
              This username has been burned and cannot be reused.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
