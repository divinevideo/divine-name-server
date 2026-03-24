// ABOUTME: Displays color-coded status badges for username states (active, reserved, revoked, burned, recovered)
// ABOUTME: Provides visual distinction between different username lifecycle states using Tailwind classes
interface StatusBadgeProps {
  status: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation'
  isRecovered?: boolean
}

export default function StatusBadge({ status, isRecovered }: StatusBadgeProps) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    reserved: 'bg-yellow-100 text-yellow-800',
    revoked: 'bg-gray-100 text-gray-800',
    burned: 'bg-red-100 text-red-800',
    'pending-confirmation': 'bg-blue-100 text-blue-800',
    recovered: 'bg-purple-100 text-purple-800'
  }

  const displayStatus = isRecovered ? 'recovered' : status

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[displayStatus] || colors[status]}`}>
      {displayStatus}
    </span>
  )
}
