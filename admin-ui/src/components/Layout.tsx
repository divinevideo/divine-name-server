// ABOUTME: Main layout component providing navigation bar and routing container for admin UI
// ABOUTME: Uses React Router Outlet to render child pages (Search, Reserve, Assign, Revoke, Reserved Words)
import { Link, Outlet, useLocation } from 'react-router-dom'

export default function Layout() {
  const location = useLocation()

  const isActive = (path: string) => location.pathname === path

  const navLinkClass = (path: string) =>
    `px-3 py-2 rounded-md text-sm font-medium ${
      isActive(path)
        ? 'bg-blue-700 text-white'
        : 'text-white hover:bg-blue-600'
    }`

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-blue-500 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-bold text-white">
                Divine Name Server - Admin
              </h1>
            </div>
            <div className="flex space-x-4">
              <Link to="/" className={navLinkClass('/')}>
                Search
              </Link>
              <Link to="/reserve" className={navLinkClass('/reserve')}>
                Reserve
              </Link>
              <Link to="/assign" className={navLinkClass('/assign')}>
                Assign
              </Link>
              <Link to="/revoke" className={navLinkClass('/revoke')}>
                Revoke
              </Link>
              <Link to="/reserved-words" className={navLinkClass('/reserved-words')}>
                Reserved Words
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
