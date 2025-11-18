// ABOUTME: Displays color-coded status badges for username states (active, reserved, revoked, burned)
// ABOUTME: Provides visual distinction between different username lifecycle states using Tailwind classes
interface StatusBadgeProps {
  status: 'active' | 'reserved' | 'revoked' | 'burned'
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const colors = {
    active: 'bg-green-100 text-green-800',
    reserved: 'bg-yellow-100 text-yellow-800',
    revoked: 'bg-gray-100 text-gray-800',
    burned: 'bg-red-100 text-red-800'
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  )
}
