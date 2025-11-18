import { useState, useEffect } from 'react'
import { getReservedWords } from '../api/client'
import type { ReservedWord } from '../types'

export default function ReservedWords() {
  const [words, setWords] = useState<ReservedWord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  const groupedByCategory = words.reduce((acc, word) => {
    if (!acc[word.category]) {
      acc[word.category] = []
    }
    acc[word.category].push(word)
    return acc
  }, {} as Record<string, ReservedWord[]>)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Reserved Words</h2>
        <p className="mt-1 text-sm text-gray-600">
          Protected words that cannot be claimed as usernames
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
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
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {categoryWords.map((word) => (
                      <tr key={word.word}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {word.word}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {word.reason || '-'}
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
