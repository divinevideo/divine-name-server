// ABOUTME: Admin page displaying all reserved words that cannot be claimed as usernames
// ABOUTME: Groups words by category with add/delete functionality
import { useState, useEffect } from 'react'
import { getReservedWords, addReservedWord, deleteReservedWord } from '../api/client'
import type { ReservedWord, MatchScope } from '../types'
import {
  USERNAME_INPUT_PATTERN,
  USERNAME_INPUT_TITLE,
  USERNAME_MAX_LENGTH,
} from '../constants/username'

const SCOPE_LABEL: Record<MatchScope, string> = {
  whole: 'whole name',
  token: 'separate word',
  anywhere: 'anywhere',
}

/** `anywhere` is the one that can reject real people, so it reads differently. */
function scopeBadgeClass(scope: MatchScope | undefined): string {
  const base = 'inline-flex rounded-full px-2 py-0.5 text-xs font-medium '
  if (scope === 'anywhere') return base + 'bg-amber-100 text-amber-800'
  if (scope === 'token') return base + 'bg-blue-100 text-blue-800'
  return base + 'bg-gray-100 text-gray-700'
}

export default function ReservedWords() {
  const [words, setWords] = useState<ReservedWord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newWord, setNewWord] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newReason, setNewReason] = useState('')
  // Starts at the safe end. A word added without thinking about scope blocks
  // only the name that is that word, which is what the old behaviour was.
  const [newScope, setNewScope] = useState<MatchScope>('whole')
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Delete state
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    loadWords()
  }, [])

  const loadWords = async () => {
    try {
      const data = await getReservedWords()
      setWords(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reserved words')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddLoading(true)
    setAddError(null)

    try {
      const result = await addReservedWord(newWord, newCategory, newReason || undefined, newScope)
      if (result.ok) {
        setNewWord('')
        setNewCategory('')
        setNewReason('')
        setNewScope('whole')
        setShowAddForm(false)
        await loadWords()
      } else {
        setAddError(result.error || 'Failed to add reserved word')
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setAddLoading(false)
    }
  }

  const handleDelete = async (word: string) => {
    setDeleteLoading(true)
    setDeleteError(null)
    try {
      const result = await deleteReservedWord(word)
      if (result.ok) {
        setDeleteConfirm(null)
        await loadWords()
      } else {
        // Leave the confirmation open: the word is still reserved, so the row
        // has to keep offering the retry rather than looking like it worked.
        setDeleteError(result.error || 'Failed to delete reserved word')
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const groupedByCategory = words.reduce((acc, word) => {
    if (!acc[word.category]) {
      acc[word.category] = []
    }
    acc[word.category].push(word)
    return acc
  }, {} as Record<string, ReservedWord[]>)

  // Get unique categories for the dropdown
  const existingCategories = [...new Set(words.map(w => w.category))].sort()

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Reserved Words</h2>
          <p className="mt-1 text-sm text-gray-600">
            Protected words that cannot be claimed as usernames
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
        >
          {showAddForm ? 'Cancel' : '+ Add Reserved Word'}
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Add Reserved Word</h3>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="newWord" className="block text-sm font-medium text-gray-700">
                  Word *
                </label>
                {/*
                  A reserved word is a username, so it uses the same rule every
                  other form here uses. The rule and the reasons behind it live in
                  constants/username.ts; it is narrower than the server, which also
                  accepts Unicode (see #93).
                */}
                <input
                  type="text"
                  id="newWord"
                  value={newWord}
                  onChange={(e) => {
                    const typed = e.target.value.trim().toLowerCase()
                    setNewWord(typed)
                    // Adding a word that is already listed updates it. Start from
                    // its current scope so changing a reason does not quietly
                    // narrow what the word blocks.
                    const existing = words.find((w) => w.word === typed)
                    if (existing) setNewScope(existing.match_scope ?? 'whole')
                  }}
                  required
                  pattern={USERNAME_INPUT_PATTERN}
                  title={USERNAME_INPUT_TITLE}
                  maxLength={USERNAME_MAX_LENGTH}
                  placeholder="example"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
                />
              </div>
              <div>
                <label htmlFor="newCategory" className="block text-sm font-medium text-gray-700">
                  Category *
                </label>
                <input
                  type="text"
                  id="newCategory"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  required
                  list="categories"
                  placeholder="system, brand, etc."
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
                />
                <datalist id="categories">
                  {existingCategories.map(cat => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
              <div>
                <label htmlFor="newReason" className="block text-sm font-medium text-gray-700">
                  Reason
                </label>
                <input
                  type="text"
                  id="newReason"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  placeholder="Why is this word reserved?"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
                />
              </div>
            </div>

            <div>
              <label htmlFor="newScope" className="block text-sm font-medium text-gray-700">
                Where it matches
              </label>
              <select
                id="newScope"
                value={newScope}
                onChange={(e) => setNewScope(e.target.value as MatchScope)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
              >
                <option value="whole">The whole name only</option>
                <option value="token">As a separate word in the name</option>
                <option value="anywhere">Anywhere inside the name</option>
              </select>
              <p className="mt-2 text-sm text-gray-500">
                {newScope === 'whole' && (
                  <>Blocks <code>{newWord || 'word'}</code> and spellings of it like <code>{(newWord || 'word').split('').join('-')}</code>, but not longer names containing it.</>
                )}
                {newScope === 'token' && (
                  <>Also blocks names where <code>{newWord || 'word'}</code> stands on its own, like <code>xx-{newWord || 'word'}-xx</code>. Not names that merely contain the letters.</>
                )}
                {newScope === 'anywhere' && (
                  <>Blocks every name containing these letters, including inside other words. Check first: <code>anal</code> set this way blocks 165 existing accounts, most of them ordinary Arabic and Spanish given names.</>
                )}
              </p>
            </div>

            {addError && (
              <div className="rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{addError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={addLoading}
                className="inline-flex justify-center rounded-md border border-transparent bg-blue-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {addLoading ? 'Adding...' : 'Add Word'}
              </button>
            </div>
          </form>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {deleteError && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{deleteError}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8">
          <p className="text-gray-500">Loading...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedByCategory).map(([category, categoryWords]) => (
            <div key={category} className="bg-white shadow rounded-lg overflow-hidden">
              <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900 capitalize">
                  {category}
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Word
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Matches
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Reason
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {categoryWords.map((word) => (
                      <tr key={word.word}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {word.word}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={scopeBadgeClass(word.match_scope)}>
                            {SCOPE_LABEL[word.match_scope ?? 'whole']}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {word.reason || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          {deleteConfirm === word.word ? (
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => handleDelete(word.word)}
                                disabled={deleteLoading}
                                className="text-red-600 hover:text-red-800 font-medium"
                              >
                                {deleteLoading ? 'Deleting...' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="text-gray-600 hover:text-gray-800"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(word.word)}
                              className="text-red-600 hover:text-red-800"
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
